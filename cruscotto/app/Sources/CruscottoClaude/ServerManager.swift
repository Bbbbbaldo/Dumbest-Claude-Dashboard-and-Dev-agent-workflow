import Foundation

/// Avvia e sorveglia il server Node del cruscotto (server.mjs).
/// Se un server è già in ascolto sulla porta (per esempio `npm start` da terminale) lo usa e basta.
@MainActor
final class ServerManager {
    let porta = 4317
    var url: URL { URL(string: "http://127.0.0.1:\(porta)/")! }

    private(set) var processo: Process?
    private var inAvvio = false
    private lazy var ambiente: [String: String] = Self.ambienteDiLogin()

    /// Cartella del cruscotto (server.mjs, public/, config.json): build.sh la scrive nell'Info.plist
    /// (chiave CartellaCruscotto). Si cambia con: defaults write <bundle id> cartellaCruscotto /percorso
    var cartella: URL {
        let p = UserDefaults.standard.string(forKey: "cartellaCruscotto")
            ?? Bundle.main.object(forInfoDictionaryKey: "CartellaCruscotto") as? String
            ?? FileManager.default.currentDirectoryPath
        return URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
    }

    let fileLog: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/CruscottoClaude/server.log")

    var avviatoDaQuestaApp: Bool { processo?.isRunning == true }

    // MARK: - API

    func leggi<T: Decodable>(_ percorso: String) async -> T? {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(porta)\(percorso)")!)
        req.timeoutInterval = 10
        req.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (dati, risposta) = try? await URLSession.shared.data(for: req),
              (risposta as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(T.self, from: dati)
    }

    func vivo() async -> Bool {
        let x: [ChatInfo]? = await leggi("/api/chat")
        return x != nil
    }

    // MARK: - ciclo di vita

    /// Garantisce un server in ascolto: se non risponde, lo avvia e aspetta che risponda.
    func assicura() async {
        if inAvvio { return }
        inAvvio = true
        defer { inAvvio = false }
        if await vivo() { return }
        if processo?.isRunning != true { avvia() }
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if await vivo() { return }
        }
    }

    func avvia() {
        guard let node = trova("node") else {
            scriviLog("node non trovato nel PATH di login: \(ambiente["PATH"] ?? "-")")
            return
        }
        let server = cartella.appendingPathComponent("server.mjs")
        guard FileManager.default.fileExists(atPath: server.path) else {
            scriviLog("server.mjs non trovato in \(cartella.path)")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--disable-warning=ExperimentalWarning", "server.mjs"]
        p.currentDirectoryURL = cartella
        var env = ambiente
        env["PORT"] = String(porta)
        p.environment = env
        if let h = apriLog() { p.standardOutput = h; p.standardError = h }
        p.terminationHandler = { proc in
            let codice = proc.terminationStatus
            Task { @MainActor in self.scriviLog("server terminato (codice \(codice))") }
        }
        do {
            try p.run()
            processo = p
            scriviLog("server avviato: pid \(p.processIdentifier), \(node) in \(cartella.path)")
        } catch {
            scriviLog("avvio del server non riuscito: \(error.localizedDescription)")
        }
    }

    func ferma() {
        guard let p = processo, p.isRunning else { processo = nil; return }
        p.terminate()
        p.waitUntilExit()
        processo = nil
    }

    /// Riavvia: ferma il proprio processo, oppure quello di un altro che occupa la porta.
    func riavvia() async {
        if avviatoDaQuestaApp {
            ferma()
        } else if let pid = pidSullaPorta() {
            kill(pid, SIGTERM)
            for _ in 0..<20 {
                if !(await vivo()) { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        await assicura()
    }

    // MARK: - supporto

    private func pidSullaPorta() -> pid_t? {
        let out = esegui("/usr/sbin/lsof", ["-tnP", "-iTCP:\(porta)", "-sTCP:LISTEN"])
        return out.split(separator: "\n").first.flatMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }

    private func trova(_ nome: String) -> String? {
        for dir in (ambiente["PATH"] ?? "").split(separator: ":") {
            let p = "\(dir)/\(nome)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    /// Le app avviate dal Finder hanno un PATH minimo: gh, git, node e claude stanno nel PATH della shell.
    private static func ambienteDiLogin() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let out = esegui("/bin/zsh", ["-lic", "env -0"], timeout: 10)
        for voce in out.split(separator: "\0") {
            guard let uguale = voce.firstIndex(of: "=") else { continue }
            let chiave = String(voce[..<uguale])
            guard chiave.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else { continue }
            env[chiave] = String(voce[voce.index(after: uguale)...])
        }
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.local/bin"]
        var path = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        for e in extra where !path.contains(e) { path.append(e) }
        env["PATH"] = path.joined(separator: ":")
        return env
    }

    private func apriLog() -> FileHandle? {
        try? FileManager.default.createDirectory(at: fileLog.deletingLastPathComponent(), withIntermediateDirectories: true)
        // O_APPEND: app e server scrivono sullo stesso file senza sovrascriversi
        let fd = open(fileLog.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        return fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
    }

    func scriviLog(_ riga: String) {
        guard let h = apriLog() else { return }
        let ora = ISO8601DateFormatter().string(from: Date())
        h.write("[app \(ora)] \(riga)\n".data(using: .utf8)!)
        try? h.close()
    }
}

@discardableResult
func esegui(_ eseguibile: String, _ argomenti: [String], timeout: TimeInterval = 5) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: eseguibile)
    p.arguments = argomenti
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    let scadenza = Date().addingTimeInterval(timeout)
    var dati = Data()
    while p.isRunning && Date() < scadenza {
        dati.append(pipe.fileHandleForReading.availableData)
    }
    if p.isRunning { p.terminate() }
    dati.append(pipe.fileHandleForReading.readDataToEndOfFile())
    return String(decoding: dati, as: UTF8.self)
}
