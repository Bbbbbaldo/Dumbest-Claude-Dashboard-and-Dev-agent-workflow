// Disegna l'icona dell'app in un .iconset: swift icona.swift <cartella.iconset>
import AppKit

let uscita = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: uscita, withIntermediateDirectories: true)

let misure: [(String, Int)] = [
    ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
    ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024),
]

func disegna(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let m = s * 0.1
    let r = NSRect(x: m, y: m, width: s - 2 * m, height: s - 2 * m)
    let forma = NSBezierPath(roundedRect: r, xRadius: r.width * 0.225, yRadius: r.width * 0.225)
    NSGradient(colors: [NSColor(red: 0.13, green: 0.17, blue: 0.42, alpha: 1),
                        NSColor(red: 0.04, green: 0.52, blue: 0.56, alpha: 1)])!.draw(in: forma, angle: -60)
    let conf = NSImage.SymbolConfiguration(pointSize: r.width * 0.46, weight: .semibold)
        .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
    if let simbolo = NSImage(systemSymbolName: "gauge.with.dots.needle.67percent", accessibilityDescription: nil)?
        .withSymbolConfiguration(conf) {
        let d = simbolo.size
        simbolo.draw(in: NSRect(x: r.midX - d.width / 2, y: r.midY - d.height / 2, width: d.width, height: d.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (nome, px) in misure {
    try disegna(px).write(to: URL(fileURLWithPath: "\(uscita)/icon_\(nome).png"))
}
