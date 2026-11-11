import AppKit
import SwiftUI
import WebKit
import UserNotifications
import ServiceManagement

struct ChatInfo: Decodable, Identifiable, Equatable {
    let id: String
    let repo: String
    let titolo: String
    let stato: String
    let permessiInAttesa: Int
}

struct SessInfo: Decodable, Identifiable, Equatable {
    let pid: Int
    let nome: String?
    let origine: String
    let stato: String
    let cartella: String
    let issue: Int?
    let chatCruscotto: Bool?
    /// false = silenziata dalla pagina o esclusa da "solo task": niente notifiche né badge
    let notifica: Bool?
    var id: Int { pid }
    var etichetta: String { issue.map { "#\($0) · \(cartella)" } ?? (nome ?? cartella) }
}

struct Totali: Decodable, Equatable {
    let sessioni: Int
    let lavorano: Int
    let ferme: Int
    let daChiudere: Int
    let permessi: Int?
}

struct ConflittoInfo: Decodable, Identifiable, Equatable {
    let chiave: String
    let repo: String
    let tipo: String      // task, piano, sessione, pr
    let numero: Int?
    let titolo: String
    let url: String?
    var id: String { chiave }
    var etichetta: String { "\(repo) · " + (numero.map { "#\($0) " } ?? "") + titolo }
}

struct StatoServer: Decodable {
    let totali: Totali
    let sessioni: [SessInfo]?
    let conflitti: [ConflittoInfo]?
    /// progetti seguiti (radici dei repo); nil = tutti
    let seguiti: [String]?
}

/// Stato condiviso dell'app: interroga il server, aggiorna barra dei menu, badge e notifiche,
/// tiene l'unica WKWebView (così la chat aperta resta tale anche chiudendo la finestra).
@MainActor
final class StatoApp: NSObject, ObservableObject {
    static let condiviso = StatoApp()

    let server = ServerManager()
    @Published var totali: Totali?
    @Published var chat: [ChatInfo] = []
    @Published var sessioni: [SessInfo] = []
    @Published var conflitti: [ConflittoInfo] = []
    @Published var raggiungibile = false
    @Published var avvioAlLogin = SMAppService.mainApp.status == .enabled

    /// impostato dalla vista della barra dei menu, che ha accesso a openWindow
    var apriFinestraSwiftUI: (() -> Void)?

    lazy var webView: WKWebView = creaWebView()

    private var timer: Timer?
    private var primoGiro = true
    private var fallimenti = 0
    private var statiSessioni: [Int: String] = [:]
    private var statiChat: [String: String] = [:]
    private var permessiChat: [String: Int] = [:]
    private var chiaviConflitti: Set<String> = []

    /// permessi in attesa: delle chat del cruscotto più delle altre sessioni (stato dagli hook)
    var permessi: Int { chat.reduce(0) { $0 + $1.permessiInAttesa } + sessioniInAttesa.count }
    var sessioniInAttesa: [SessInfo] { sessioni.filter { $0.stato == "permesso" && $0.chatCruscotto != true && $0.notifica != false } }
    var chatInAttesa: [ChatInfo] { chat.filter { $0.permessiInAttesa > 0 } }
    var sessioniAlLavoro: [SessInfo] { sessioni.filter { $0.stato == "busy" && $0.chatCruscotto != true } }

    func avvia() {
        let centro = UNUserNotificationCenter.current()
        centro.delegate = self
        centro.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        Task {
            await server.assicura()
            webView.load(URLRequest(url: server.url))
            await giro()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.giro() }
        }
    }

    func chiudi() {
        timer?.invalidate()
        server.ferma()
    }

    // MARK: - polling

    func giro() async {
        async let c: [ChatInfo]? = server.leggi("/api/chat")
        async let s: StatoServer? = server.leggi("/api/stato")
        let (tutteLeChat, nuovoStato) = await (c, s)
        guard let tutteLeChat, let nuovoStato else {
            raggiungibile = false
            fallimenti += 1
            if fallimenti >= 2 {
                fallimenti = 0
                await server.assicura()
                if await server.vivo() { webView.reload() }
            }
            return
        }
        if !raggiungibile && !primoGiro { webView.reload() }
        raggiungibile = true
        fallimenti = 0
        // le sessioni arrivano già filtrate dal server; le chat del cruscotto si filtrano qui
        let seguiti = nuovoStato.seguiti.map(Set.init)
        let nuoveChat = seguiti.map { s in tutteLeChat.filter { s.contains($0.repo) } } ?? tutteLeChat
        let nuoveSessioni = nuovoStato.sessioni ?? []

        let nuoviConflitti = nuovoStato.conflitti ?? []
        if !primoGiro {
            notificaCambi(chat: nuoveChat, sessioni: nuoveSessioni)
            for c in nuoviConflitti where !chiaviConflitti.contains(c.chiave) {
                notifica("Conflitto di merge: \(c.repo)", (c.numero.map { "#\($0) " } ?? "") + c.titolo, chat: nil)
            }
        }
        chiaviConflitti = Set(nuoviConflitti.map(\.chiave))
        if conflitti != nuoviConflitti { conflitti = nuoviConflitti }
        primoGiro = false
        permessiChat = Dictionary(uniqueKeysWithValues: nuoveChat.map { ($0.id, $0.permessiInAttesa) })
        statiChat = Dictionary(uniqueKeysWithValues: nuoveChat.map { ($0.id, $0.stato) })
        statiSessioni = Dictionary(nuoveSessioni.map { ($0.pid, $0.stato) }, uniquingKeysWith: { a, _ in a })

        if chat != nuoveChat { chat = nuoveChat }
        if sessioni != nuoveSessioni { sessioni = nuoveSessioni }
        if totali != nuovoStato.totali { totali = nuovoStato.totali }
        NSApp.dockTile.badgeLabel = permessi > 0 ? String(permessi) : nil
    }

    private func notificaCambi(chat nuove: [ChatInfo], sessioni nuoveSess: [SessInfo]) {
        for c in nuove {
            if c.permessiInAttesa > (permessiChat[c.id] ?? 0) {
                notifica("Claude chiede un permesso", c.titolo, chat: c.id)
            } else if statiChat[c.id] == "lavora" && c.stato == "pronta" {
                notifica("Chat: risposta pronta", c.titolo, chat: c.id)
            }
        }
        for s in nuoveSess where s.chatCruscotto != true && s.notifica != false {
            if s.stato == "permesso" && statiSessioni[s.pid] != "permesso" {
                notifica("Sessione chiede un permesso: \(s.etichetta)", "\(s.origine) · aspetta la tua approvazione", chat: nil)
            } else if statiSessioni[s.pid] == "busy" && s.stato == "idle" {
                notifica("Sessione ferma: \(s.etichetta)", "\(s.origine) · aspetta te o ha finito", chat: nil)
            }
        }
    }

    private func notifica(_ titolo: String, _ testo: String, chat: String?) {
        let c = UNMutableNotificationContent()
        c.title = titolo
        c.body = testo
        c.sound = .default
        if let chat { c.userInfo = ["chat": chat] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: - azioni

    func apriFinestra() {
        NSApp.activate(ignoringOtherApps: true)
        if let w = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("principale") == true && $0.isVisible }) {
            w.makeKeyAndOrderFront(nil)
        } else {
            apriFinestraSwiftUI?()
        }
    }

    func apriChat(_ id: String?) {
        apriFinestra()
        let arg = id.flatMap { try? String(data: JSONEncoder().encode($0), encoding: .utf8) } ?? "null"
        let js = id == nil ? "mostraChat(true)" : "apriChat(\(arg)); mostraChat(true)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.webView.evaluateJavaScript(js) }
    }

    func ricarica() { webView.reload() }

    func riavviaServer() {
        raggiungibile = false
        Task {
            await server.riavvia()
            webView.reload()
            await giro()
        }
    }

    func mostraLog() { NSWorkspace.shared.open(server.fileLog) }

    func apriCartella() { NSWorkspace.shared.open(server.cartella) }

    func cambiaAvvioAlLogin(_ attivo: Bool) {
        do {
            if attivo { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            let a = NSAlert()
            a.messageText = "Avvio al login non modificato"
            a.informativeText = "\(error.localizedDescription)\n\nSe macOS lo chiede, abilitalo in Impostazioni di Sistema → Generali → Elementi login."
            a.runModal()
        }
        avvioAlLogin = SMAppService.mainApp.status == .enabled
    }

    // MARK: - web view

    private func creaWebView() -> WKWebView {
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()
        let w = WKWebView(frame: .zero, configuration: conf)
        w.uiDelegate = self
        w.navigationDelegate = self
        w.isInspectable = true
        w.setValue(false, forKey: "drawsBackground")
        return w
    }
}

// MARK: - WebKit

extension StatoApp: WKUIDelegate, WKNavigationDelegate {
    // link con target=_blank (GitHub, PR, issue): nel browser predefinito
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            webView.load(URLRequest(url: self.server.url))
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let a = NSAlert()
        a.messageText = "Cruscotto agenti"
        a.informativeText = message
        a.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = "Cruscotto agenti"
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Annulla")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
}

// MARK: - notifiche

extension StatoApp: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // con l'app in primo piano la cosa si vede già nella finestra
        DispatchQueue.main.async {
            completionHandler(NSApp.isActive ? [] : [.banner, .sound])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let chat = response.notification.request.content.userInfo["chat"] as? String
        DispatchQueue.main.async {
            Task { @MainActor in
                if let chat { StatoApp.condiviso.apriChat(chat) } else { StatoApp.condiviso.apriFinestra() }
                completionHandler()
            }
        }
    }
}
