// imgtool — attachment-local 的图像后端 (Go, 纯 stdlib + x/image, 无 cgo)
//
// 为什么存在: sharp 在 Android ARM64 没有预编译 binding (0.35.4 只出
// linux/darwin/win32/freebsd/wasm 平台包, npm 上没有 android-arm64),
// require("sharp") 在真机上必然抛错 —— screen_image 因此全链路不可用。
// 这个工具用纯 Go 实现归一化需要的最小操作集, 由 JS shim
// (dsh/shim/sharp-android.js) 以子进程方式调用, 对 attachment-local 伪装成 sharp。
//
// 协议: stdin 一行 JSON 请求 → stdout 一行 JSON 响应。图像字节走 base64。
//
//	请求: { op, data(b64), width?, height?, qualities?:[85,75,60], rotate?:bool }
//	响应: { ok:true, result:{...} } 或 { ok:false, error }
//
// op:
//	detect     完整解码 (证明可解码) + 逐像素查证 alpha; 返回 sharp metadata 需要的事实
//	normalize  解码 → (可选 EXIF 旋转) → 等比缩到框内 → sRGB 8bit → 按梯度一次算出多个 JPEG
//
// ── 三条硬约束 (都是 attachment-local 的行为决定的, 不能想当然) ──────────
//
//  1. hasAlpha 必须按**像素**诚实, 不能按格式波段报。
//     imageMetadata 的 hasAlpha 进 encodingLadder 决定 webp/jpeg; 而 Go 生态
//     (golang.org/x/image) 只有 webp 解码没有编码。真机 screencap PNG 是
//     RGBA(colorType 6) 但像素全不透明 —— 按波段报 true 就会去走 webp 阶梯,
//     然后必然失败。按像素报 false 则走 JPEG 阶梯, 视觉无损。
//     真透明图 (存在 alpha != 255 的像素) v1 明确报错, 不静默压平。
//
//  2. orientation 只在**真有 EXIF** 时才上报 (解出 1..8 才报)。
//     carriesRetainedMetadata 把 orientation !== undefined 当成"带元数据";
//     verifyNormalizedImage 又要求归一化产物的 carriesMetadata 为 false。
//     若对无 EXIF 的图凭空报 orientation=1, 我们自己的 JPEG 输出也会被判成
//     "带元数据", 归一化永远过不了验证。
//
//  3. depth/space 要报真值。canPassThroughNormalization 要求 uchar + srgb;
//     16bit PNG 报 ushort 才能挡住"直接放行"。space 一律 srgb (本链路没有
//     CMYK/线性光源; 4 分量 JPEG 纯 Go 解不了, 直接报错, 不谎报)。
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"  // 注册 gif 解码 (image.Decode 用)
	"image/jpeg"   // 编码器; 同时注册 jpeg 解码
	_ "image/png"  // 注册 png 解码 (IHDR 事实由 parsePNG 自解析)
	"io"
	"os"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // 注册 webp 解码 (无编码器)
)

// ── 请求/响应 ──────────────────────────────────────────────

type request struct {
	Op        string `json:"op"`
	Data      string `json:"data"` // base64 图像字节
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Qualities []int  `json:"qualities"`
	Rotate    bool   `json:"rotate"`
}

type response struct {
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	Result any    `json:"result,omitempty"`
}

// metaResult 是 sharp metadata() 需要的事实的等价物 (JS shim 再翻译成 sharp 的字段名)。
type metaResult struct {
	Format      string   `json:"format"` // png | jpeg | webp | gif
	Width       int      `json:"width"`
	Height      int      `json:"height"`
	Depth       string   `json:"depth"` // uchar | ushort
	Space       string   `json:"space"` // srgb | b-w
	Channels    int      `json:"channels"`
	HasAlpha    bool     `json:"hasAlpha"` // 像素级: 存在 alpha < 255
	Pages       int      `json:"pages"`     // 帧数; >1 = 动图
	Animated    bool     `json:"animated"`
	Orientation int      `json:"orientation"` // 0 = 无 EXIF orientation
	// Retained 是"会被归一化丢弃、且 sharp 会通过 metadata 暴露出来"的字段名列表
	// (用上游 carriesRetainedMetadata 认的那些名字: icc/exif/xmp/iptc/comments/
	// tifftagPhotoshop/hasProfile)。不报布尔而是报名字, 是为了让 JS shim 能把这些
	// 字段真实地摆在 metadata 上, 由上游自己的规则去判定 —— 规则只有一份, 不会漂移。
	Retained []string `json:"retained"`
}

type encoded struct {
	Data    string `json:"data"` // base64 JPEG
	Quality int    `json:"quality"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Bytes   int    `json:"bytes"`
}

type normalizeResult struct {
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	HasAlpha  bool      `json:"hasAlpha"` // 归一化产物 (JPEG 恒 false)
	Encodings []encoded `json:"encodings"`
}

// ── PNG 头解析 ────────────────────────────────────────────
//
// 需要 IHDR 的 bitDepth/colorType (depth 与 alpha 波段), 以及有没有
// 非良性 chunk (iCCP/sBIT/eXIf/tEXt... → carriesMetadata)。
// 真机 screencap PNG 实测带 iCCP(299B)+sBIT(4B), 所以 carriesMetadata=true,
// 归一化路径无法绕过 —— 这也正是本工具存在的理由。

type pngHeader struct {
	width, height int
	bitDepth      int
	colorType     int
	hasTRNS       bool
	retained      []string
}

// pngRetainedFields 把 PNG chunk 映射成 sharp 会暴露的 metadata 字段名。
//
// 判定依据是上游 carriesRetainedMetadata 认的字段: exif/xmp/iptc/icc/
// hasProfile/tifftagPhotoshop/comments/orientation。所以:
//   - iCCP  → icc (+hasProfile)
//   - eXIf  → exif
//   - tEXt/zTXt → comments
//   - iTXt  → 关键字是 XML:com.adobe.xmp 时是 xmp, 否则 comments
//   - 认不出来的 chunk → comments (兜底: 宁可多归一化一次, 不可把未知元数据
//     原样留在库里再喂给模型)
//
// 明确**不算**的: IHDR/IDAT/PLTE/tRNS/pHYs/gAMA/sRGB/cHRM/iDOT/bKGD/tIME,
// 以及 sBIT —— sharp 不把 sBIT 变成任何 metadata 字段, 所以 sBIT 单独存在时
// 真 sharp 也会判定"无元数据"而直接放行; 我们保持一致。
func pngRetainedFields(typ string, body []byte) []string {
	switch typ {
	case "IHDR", "IDAT", "PLTE", "tRNS", "pHYs", "gAMA", "sRGB", "cHRM", "iDOT", "bKGD", "tIME", "sBIT":
		return nil
	case "iCCP":
		return []string{"icc", "hasProfile"}
	case "eXIf":
		return []string{"exif"}
	case "tEXt", "zTXt":
		return []string{"comments"}
	case "iTXt":
		if bytes.HasPrefix(body, []byte("XML:com.adobe.xmp")) {
			return []string{"xmp"}
		}
		return []string{"comments"}
	}
	return []string{"comments"}
}

func parsePNG(data []byte) (pngHeader, error) {
	const sig = "\x89PNG\r\n\x1a\n"
	var h pngHeader
	if len(data) < 8 || string(data[:8]) != sig {
		return h, fmt.Errorf("not a png")
	}
	seenIHDR := false
	seenRetained := map[string]bool{}
	pos := 8
	for pos+8 <= len(data) {
		length := uint32(data[pos])<<24 | uint32(data[pos+1])<<16 | uint32(data[pos+2])<<8 | uint32(data[pos+3])
		typ := string(data[pos+4 : pos+8])
		if pos+12+int(length) > len(data) {
			return h, fmt.Errorf("png chunk overruns buffer")
		}
		body := data[pos+8 : pos+8+int(length)]
		switch typ {
		case "IHDR":
			if len(body) < 13 {
				return h, fmt.Errorf("short IHDR")
			}
			h.width = int(body[0])<<24 | int(body[1])<<16 | int(body[2])<<8 | int(body[3])
			h.height = int(body[4])<<24 | int(body[5])<<16 | int(body[6])<<8 | int(body[7])
			h.bitDepth = int(body[8])
			h.colorType = int(body[9])
			seenIHDR = true
		case "tRNS":
			h.hasTRNS = true
		case "IEND":
			if !seenIHDR {
				return h, fmt.Errorf("png missing IHDR")
			}
			return h, nil
		}
		for _, f := range pngRetainedFields(typ, body) {
			if !seenRetained[f] {
				seenRetained[f] = true
				h.retained = append(h.retained, f)
			}
		}
		pos += 12 + int(length)
	}
	return h, fmt.Errorf("png missing IEND")
}

// pngHasAlphaBand 格式层是否**可能**有 alpha (colorType 4/6, 或调色板带 tRNS)。
func (h pngHeader) hasAlphaBand() bool {
	return h.colorType == 4 || h.colorType == 6 || (h.colorType == 3 && h.hasTRNS)
}

// ── JPEG 头解析 ───────────────────────────────────────────

type jpegHeader struct {
	retained    []string
	orientation int // 1..8; 0 = 无
}

// jpegRetainedFields 把 JPEG 段映射成 sharp metadata 字段名。
//
//	APP1 + "Exif\0\0"                  → exif (+ orientation)
//	APP1 + "http://ns.adobe.com/xap/"  → xmp
//	APP2 + "ICC_PROFILE"               → icc (+hasProfile)
//	APP13                              → iptc, tifftagPhotoshop
//	COM                                → comments
//	APP3..APP12/APP15 (认不出)         → comments (兜底)
//	APP0 (JFIF) / APP14 (Adobe 变换)   → 不算元数据 (容器级, sharp 不暴露)
func jpegRetainedFields(marker byte, body []byte) []string {
	switch marker {
	case 0xE1:
		if bytes.HasPrefix(body, []byte("Exif\x00\x00")) {
			return []string{"exif"}
		}
		if bytes.HasPrefix(body, []byte("http://ns.adobe.com/xap/1.0/\x00")) {
			return []string{"xmp"}
		}
		return []string{"comments"}
	case 0xE2:
		if bytes.HasPrefix(body, []byte("ICC_PROFILE\x00")) {
			return []string{"icc", "hasProfile"}
		}
		return []string{"comments"}
	case 0xED:
		return []string{"iptc", "tifftagPhotoshop"}
	case 0xFE:
		return []string{"comments"}
	case 0xE0, 0xEE:
		return nil // JFIF / Adobe APP14: 容器级, 不产生 metadata 字段
	case 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xEF:
		return []string{"comments"}
	}
	return nil
}

func parseJPEG(data []byte) (jpegHeader, error) {
	var h jpegHeader
	seen := map[string]bool{}
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return h, fmt.Errorf("not a jpeg")
	}
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xFF {
			return h, fmt.Errorf("bad jpeg marker at %d", pos)
		}
		marker := data[pos+1]
		// 无载荷标记
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			pos += 2
			continue
		}
		if marker == 0xD9 { // EOI
			return h, nil
		}
		segLen := int(data[pos+2])<<8 | int(data[pos+3])
		if segLen < 2 || pos+2+segLen > len(data) {
			return h, fmt.Errorf("bad jpeg segment length")
		}
		body := data[pos+4 : pos+2+segLen]
		if marker == 0xDA { // SOS: 后面是熵编码数据, 不再扫
			return h, nil
		}
		if marker == 0xE1 {
			if o := exifOrientation(body); o != 0 {
				h.orientation = o
			}
		}
		for _, f := range jpegRetainedFields(marker, body) {
			if !seen[f] {
				seen[f] = true
				h.retained = append(h.retained, f)
			}
		}
		pos += 2 + segLen
	}
	return h, nil
}

// exifOrientation 从 APP1 载荷里取 orientation (TIFF IFD0 tag 0x0112)。
// 只认 EXIF 签, XMP 载荷直接放过 (它不是 TIFF)。
func exifOrientation(body []byte) int {
	const exifSig = "Exif\x00\x00"
	if len(body) < 6+8 || string(body[:6]) != exifSig {
		return 0
	}
	tiff := body[6:]
	var bo binaryOrder
	switch {
	case len(tiff) >= 2 && tiff[0] == 'I' && tiff[1] == 'I':
		bo = littleEndian
	case len(tiff) >= 2 && tiff[0] == 'M' && tiff[1] == 'M':
		bo = bigEndian
	default:
		return 0
	}
	if bo.u16(tiff[2:]) != 42 {
		return 0
	}
	ifdOff := int(bo.u32(tiff[4:]))
	if ifdOff < 8 || ifdOff+2 > len(tiff) {
		return 0
	}
	n := int(bo.u16(tiff[ifdOff:]))
	entry := ifdOff + 2
	for i := 0; i < n && entry+12 <= len(tiff); i, entry = i+1, entry+12 {
		tag := bo.u16(tiff[entry:])
		if tag != 0x0112 {
			continue
		}
		typ := bo.u16(tiff[entry+2:])
		count := int(bo.u32(tiff[entry+4:]))
		if typ != 3 || count < 1 { // SHORT
			return 0
		}
		v := int(bo.u16(tiff[entry+8:]))
		if v >= 1 && v <= 8 {
			return v
		}
		return 0
	}
	return 0
}

type binaryOrder int

const (
	littleEndian binaryOrder = iota
	bigEndian
)

func (b binaryOrder) u16(p []byte) int {
	if b == littleEndian {
		return int(p[0]) | int(p[1])<<8
	}
	return int(p[0])<<8 | int(p[1])
}

func (b binaryOrder) u32(p []byte) uint32 {
	if b == littleEndian {
		return uint32(p[0]) | uint32(p[1])<<8 | uint32(p[2])<<16 | uint32(p[3])<<24
	}
	return uint32(p[0])<<24 | uint32(p[1])<<16 | uint32(p[2])<<8 | uint32(p[3])
}

// ── GIF ───────────────────────────────────────────────────
//
// 只需要帧数 (动图判定)。stdlib 的 gif.DecodeAll 会整帧解出来, 对一个 3MB
// 的动图很亏; 数一下 Image Descriptor (0x2C) 就够了 —— 但要跳过各块的
// 子块结构, 不能盲目扫字节 (0x2C 会出现在数据里)。

func gifFrameCount(data []byte) int {
	if len(data) < 13 || string(data[:3]) != "GIF" {
		return 1
	}
	flags := int(data[10])
	pos := 13
	if flags&0x80 != 0 { // Global Color Table
		pos += 3 * (1 << ((flags & 0x07) + 1))
	}
	frames := 0
	for pos < len(data) {
		switch data[pos] {
		case 0x3B: // Trailer
			if frames == 0 {
				return 1
			}
			return frames
		case 0x21: // Extension: label + sub-blocks
			if pos+2 > len(data) {
				return max(1, frames)
			}
			pos += 2
			for pos < len(data) {
				size := int(data[pos])
				pos++
				if size == 0 {
					break
				}
				pos += size
			}
		case 0x2C: // Image Descriptor
			frames++
			if pos+10 > len(data) {
				return frames
			}
			lflags := int(data[pos+9])
			pos += 10
			if lflags&0x80 != 0 { // Local Color Table
				pos += 3 * (1 << ((lflags & 0x07) + 1))
			}
			if pos >= len(data) {
				return frames
			}
			pos++ // LZW minimum code size
			for pos < len(data) {
				size := int(data[pos])
				pos++
				if size == 0 {
					break
				}
				pos += size
			}
		default:
			return max(1, frames)
		}
	}
	return max(1, frames)
}

// ── 解码 ──────────────────────────────────────────────────

func decodeAny(data []byte) (image.Image, string, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	_ = cfg
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", err
	}
	return img, format, nil
}

// alphaFacts 逐像素查 alpha。
//
// 返回 (hasAlphaBand, hasRealAlpha):
//	hasAlphaBand  — 格式层有没有 alpha 通道
//	hasRealAlpha  — 真的存在 alpha < 255 的像素
// 泛型路径对 png/jpeg/gif/webp 的所有具体类型都成立 (At().RGBA() 的
// alpha 通道就是真相), 快速路径只是省掉接口调用。
func alphaFacts(img image.Image) (hasAlphaBand, hasRealAlpha bool) {
	switch m := img.(type) {
	case *image.NRGBA:
		for i := 3; i < len(m.Pix); i += 4 {
			if m.Pix[i] != 0xFF {
				return true, true
			}
		}
		return true, false
	case *image.RGBA: // 预乘; alpha=255 时 RGB 未被缩减, 值即原值
		for i := 3; i < len(m.Pix); i += 4 {
			if m.Pix[i] != 0xFF {
				return true, true
			}
		}
		return true, false
	case *image.NRGBA64:
		for i := 6; i < len(m.Pix); i += 8 {
			if m.Pix[i] != 0xFF || m.Pix[i+1] != 0xFF {
				return true, true
			}
		}
		return true, false
	case *image.Gray, *image.Gray16, *image.CMYK, *image.YCbCr:
		return false, false // 无 alpha 通道
	}
	// 兜底 (Paletted 及将来的类型): 用接口逐点问。
	// 注意 Paletted 的调色板透明项在这里会被正确识别成 real alpha。
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a != 0xFFFF {
				return true, true
			}
		}
	}
	return false, false
}

// ── 旋转 (EXIF orientation) ────────────────────────────────

func rotateNRGBA(src *image.NRGBA, orientation int) *image.NRGBA {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	swap := orientation >= 5
	dw, dh := sw, sh
	if swap {
		dw, dh = sh, sw
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < sh; y++ {
		for x := 0; x < sw; x++ {
			var nx, ny int
			switch orientation {
			case 2: // 水平镜像
				nx, ny = sw-1-x, y
			case 3: // 180°
				nx, ny = sw-1-x, sh-1-y
			case 4: // 垂直镜像
				nx, ny = x, sh-1-y
			case 5: // 转置
				nx, ny = y, x
			case 6: // 顺时针 90°
				nx, ny = sh-1-y, x
			case 7: // 反转置
				nx, ny = sh-1-y, sw-1-x
			case 8: // 逆时针 90°
				nx, ny = y, sw-1-x
			}
			si := src.PixOffset(x, y)
			di := dst.PixOffset(nx, ny)
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// ── 缩放 ──────────────────────────────────────────────────

// toNRGBA 统一转 8bit 非预乘 RGBA (sRGB 语义)。
func toNRGBA(img image.Image) *image.NRGBA {
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
	return dst
}

// resizeInside 等比缩到 (width,height) 框内, 不放大; 0 表示该边不限。
//
// attachment-local 两种用法都要支持:
//   - resize({width,height,fit:"inside"})  → 双边约束, 取较小比例
//   - resize({width}) / resize({height})   → 单边约束, 等比精确缩放
//
// 取整用 trunc, 与 libvips 的 resize 一致 (libvips 用 floor)。
func resizeInside(src *image.NRGBA, width, height int) *image.NRGBA {
	if width <= 0 && height <= 0 {
		return src
	}
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	scale := 0.0
	switch {
	case width > 0 && height > 0:
		scale = min(float64(width)/float64(sw), float64(height)/float64(sh))
	case width > 0:
		scale = float64(width) / float64(sw)
	default:
		scale = float64(height) / float64(sh)
	}
	if scale >= 1 { // withoutEnlargement
		return src
	}
	dw := max(1, int(float64(sw)*scale))
	dh := max(1, int(float64(sh)*scale))
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	// CatmullRom 与 libvips 默认的 Lanczos3 质量相当 (略软), 远好于 NearestNeighbor。
	// 输出尺寸由上面算好, 是确定性的 —— 字节预算的可预测性来自这里。
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	return dst
}

func encodeJPEG(img *image.NRGBA, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ── 操作 ──────────────────────────────────────────────────

func opDetect(data []byte) (metaResult, error) {
	img, format, err := decodeAny(data)
	if err != nil {
		return metaResult{}, fmt.Errorf("unsupported or malformed image data: %w", err)
	}
	m := metaResult{Format: format, Depth: "uchar", Space: "srgb", Pages: 1}
	b := img.Bounds()
	m.Width, m.Height = b.Dx(), b.Dy()

	switch format {
	case "png":
		h, err := parsePNG(data)
		if err != nil {
			return metaResult{}, err
		}
		m.Retained = h.retained
		if h.bitDepth == 16 {
			m.Depth = "ushort"
		}
	case "jpeg":
		h, err := parseJPEG(data)
		if err != nil {
			return metaResult{}, err
		}
		m.Retained = h.retained
		m.Orientation = h.orientation
	case "gif":
		m.Pages = gifFrameCount(data)
		m.Animated = m.Pages > 1
		// GIF 的扩展块 (注释/循环/应用) 纯 Go 解码器不暴露, 保守按 comments 处理。
		// 注意 GIF 本来就无法通过 canPassThroughNormalization (上游显式排除
		// image/gif), 所以这里的保守不会改变走没走归一化。
		m.Retained = []string{"comments"}
	case "webp":
		// 纯 Go 解码器不暴露 chunk 结构: 无法证明"干净", 保守报一个上游认得的
		// 字段名, 强制走归一化 (归一化是幂等且视觉无损的)。
		m.Retained = []string{"comments"}
	}

	band, real := alphaFacts(img)
	m.HasAlpha = real // 像素级诚实, 见文件头约束 1
	gray := false
	switch img.(type) {
	case *image.Gray, *image.Gray16:
		gray = true
		m.Space = "b-w" // 与 libvips 一致: 灰度不是 srgb, 因此不会"直接放行"
	}
	switch {
	case band && gray:
		m.Channels = 2
	case band:
		m.Channels = 4
	case gray:
		m.Channels = 1
	default:
		m.Channels = 3
	}
	// 空列表要序列化成 [] 而不是 null: JS 侧要靠它判断"有没有元数据",
	// null 会逼调用方到处写 ?? []（协议自己说清楚，别让调用方兜底）。
	if m.Retained == nil {
		m.Retained = []string{}
	}
	return m, nil
}

func opNormalize(data []byte, width, height int, qualities []int, rotate bool) (normalizeResult, error) {
	img, format, err := decodeAny(data)
	if err != nil {
		return normalizeResult{}, fmt.Errorf("unsupported or malformed image data: %w", err)
	}
	_, real := alphaFacts(img)
	if real {
		return normalizeResult{}, fmt.Errorf("TRANSPARENT_NOT_SUPPORTED: source has pixels with alpha < 255 and this build has no webp encoder")
	}
	rgba := toNRGBA(img)
	// .rotate() 无参 = 按 EXIF 自动摆正。只有真解出 orientation 才动;
	// PNG 无 orientation 概念 (eXIf 极少见, v1 不处理)。
	if rotate && format == "jpeg" {
		if h, err := parseJPEG(data); err == nil && h.orientation != 0 {
			rgba = rotateNRGBA(rgba, h.orientation)
		}
	}
	rgba = resizeInside(rgba, width, height)
	if len(qualities) == 0 {
		qualities = []int{85, 75, 60}
	}
	out := normalizeResult{Width: rgba.Bounds().Dx(), Height: rgba.Bounds().Dy(), HasAlpha: false}
	for _, q := range qualities {
		q = min(100, max(1, q))
		j, err := encodeJPEG(rgba, q)
		if err != nil {
			return normalizeResult{}, err
		}
		out.Encodings = append(out.Encodings, encoded{
			Data: base64.StdEncoding.EncodeToString(j), Quality: q,
			Width: out.Width, Height: out.Height, Bytes: len(j),
		})
	}
	return out, nil
}

// ── main ──────────────────────────────────────────────────

func main() {
	in, err := io.ReadAll(bufio.NewReader(os.Stdin))
	if err != nil {
		emitErr(err)
		return
	}
	var req request
	if err := json.Unmarshal(in, &req); err != nil {
		emitErr(err)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil {
		emitErr(fmt.Errorf("bad base64 payload: %w", err))
		return
	}
	switch req.Op {
	case "detect":
		r, err := opDetect(raw)
		if err != nil {
			emitErr(err)
			return
		}
		emitOK(r)
	case "raw":
		// raw 的载荷是像素本身, 走"JSON 行 + 二进制体"的帧格式, 免得把十几 MB
		// 的像素 base64 一遍 (base64 要 +33%, 还要在 JS 侧再解回来)。
		r, err := opDetect(raw)
		if err != nil {
			emitErr(err)
			return
		}
		img, _, err := decodeAny(raw)
		if err != nil {
			emitErr(err)
			return
		}
		px, ch := rawPixels(img)
		r.Channels = ch
		head, _ := json.Marshal(response{OK: true, Result: rawFrame{Meta: r, Bytes: len(px)}})
		os.Stdout.Write(head)
		os.Stdout.Write([]byte("\n"))
		os.Stdout.Write(px)
	case "normalize":
		r, err := opNormalize(raw, req.Width, req.Height, req.Qualities, req.Rotate)
		if err != nil {
			emitErr(err)
			return
		}
		emitOK(r)
	default:
		emitErr(fmt.Errorf("unknown op: %s", req.Op))
	}
}

// rawFrame 是 raw 操作的 JSON 头; 像素字节紧跟其后 (紧跟着一个 '\n')。
type rawFrame struct {
	Meta  metaResult `json:"meta"`
	Bytes int        `json:"bytes"`
}

// rawPixels 返回 8bit 逐像素 sRGB 数据: 有 alpha 通道时 4 波段 (非预乘),
// 否则 3 波段 —— 与 sharp raw() 对 8bit sRGB 输入的行为一致。
func rawPixels(img image.Image) ([]byte, int) {
	src := toNRGBA(img)
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	band, _ := alphaFacts(img)
	ch := 3
	if band {
		ch = 4
	}
	out := make([]byte, 0, sw*sh*ch)
	for y := 0; y < sh; y++ {
		row := src.Pix[y*src.Stride : y*src.Stride+sw*4]
		for x := 0; x < sw; x++ {
			p := row[x*4 : x*4+4]
			out = append(out, p[0], p[1], p[2])
			if ch == 4 {
				out = append(out, p[3])
			}
		}
	}
	return out, ch
}

func emitOK(result any) {
	out, _ := json.Marshal(response{OK: true, Result: result})
	os.Stdout.Write(out)
}

// emitErr 走响应体而不是退出码: 协议层错误是"这个图不行", 不是"工具坏了",
// JS 侧要能区分并抛出带原因的 Error。
func emitErr(err error) {
	out, _ := json.Marshal(response{OK: false, Error: err.Error()})
	os.Stdout.Write(out)
}
