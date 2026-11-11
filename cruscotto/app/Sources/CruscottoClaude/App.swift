import AppKit
import SwiftUI
import WebKit

@main
struct CruscottoClaudeApp: App {
    @NSApplicationDelegateAdaptor(Delegato.self) private var delegato
    @StateObject private var stato = StatoApp.condiviso

    var body: some Scene {
        Window("Cruscotto agenti", id: "principale") {
            FinestraPrincipale()
                .environmentObject(stato)
                .frame(minWidth: 820, minHeight: 560)
        }
        .defaultSize(width: 1440, height: 920)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Ricarica pagina") { stato.ricarica() }.keyboardShortcut("r")
                Button("Apri chat") { stato.apriChat(nil) }.keyboardShortcut("k")
                Divider()
                Button("Riavvia server") { stato.riavviaServer() }.keyboardShortcut("r", modifiers: [.command, .shift])
                Button("Mostra log del server") { stato.mostraLog() }
            }
        }

        MenuBarExtra {
            MenuBarra().environmentObject(stato)
        } label: {
            EtichettaBarra().environmentObject(stato)
        }
        .menuBarExtraStyle(.menu)
    }
}

final class Delegato: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { StatoApp.condiviso.avvia() }
    }

    // chiudere la finestra non chiude l'app: resta nella barra dei menu
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { MainActor.assumeIsolated { StatoApp.condiviso.apriFinestra() } }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { StatoApp.condiviso.chiudi() }
    }
}

struct FinestraPrincipale: View {
    @EnvironmentObject var stato: StatoApp

    var body: some View {
        ZStack {
            ContenitoreWeb(webView: stato.webView)
            if !stato.raggiungibile {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Avvio del server del cruscotto…").foregroundStyle(.secondary)
                    Button("Mostra log") { stato.mostraLog() }.buttonStyle(.link)
                }
                .padding(24)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .ignoresSafeArea(.container, edges: .top)
    }
}

struct ContenitoreWeb: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct EtichettaBarra: View {
    @EnvironmentObject var stato: StatoApp
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let icona = stato.permessi > 0 ? "exclamationmark.bubble.fill"
            : !stato.raggiungibile ? "gauge.with.dots.needle.0percent"
            : (stato.totali?.lavorano ?? 0) > 0 ? "gauge.with.dots.needle.67percent" : "gauge.with.dots.needle.33percent"
        HStack(spacing: 3) {
            Image(systemName: icona)
            if stato.permessi > 0 {
                Text("\(stato.permessi)")
            } else if let l = stato.totali?.lavorano, l > 0 {
                Text("\(l)")
            }
        }
        .onAppear {
            stato.apriFinestraSwiftUI = {
                openWindow(id: "principale")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }
}

struct MenuBarra: View {
    @EnvironmentObject var stato: StatoApp

    var body: some View {
        if !stato.raggiungibile {
            Text("Server non raggiungibile")
        } else if let t = stato.totali {
            Text("\(t.sessioni) sessioni · \(t.lavorano) lavorano · \(t.ferme) ferme")
        }
        if stato.permessi > 0 {
            Text("\(stato.permessi) permessi in attesa")
        }
        if !stato.sessioniInAttesa.isEmpty {
            Section("Sessioni che chiedono un permesso") {
                ForEach(stato.sessioniInAttesa) { s in
                    Button("⚠︎ \(s.origine) · \(s.etichetta)") { stato.apriFinestra() }
                }
            }
        }

        if !stato.conflitti.isEmpty {
            Section("Conflitti di merge") {
                ForEach(stato.conflitti) { c in
                    Button("⛔︎ \(c.etichetta)") {
                        if let u = c.url.flatMap(URL.init(string:)) { NSWorkspace.shared.open(u) } else { stato.apriFinestra() }
                    }
                }
            }
        }

        Button("Apri cruscotto") { stato.apriFinestra() }.keyboardShortcut("o")
        Button("Apri chat") { stato.apriChat(nil) }

        if !stato.chatInAttesa.isEmpty {
            Divider()
            Section("Chiedono un permesso") {
                ForEach(stato.chatInAttesa) { c in
                    Button("⚠︎ \(c.titolo)") { stato.apriChat(c.id) }
                }
            }
        }
        let attive = stato.chat.filter { $0.stato == "lavora" && $0.permessiInAttesa == 0 }
        if !attive.isEmpty {
            Divider()
            Section("Chat al lavoro") {
                ForEach(attive) { c in Button(c.titolo) { stato.apriChat(c.id) } }
            }
        }
        if !stato.sessioniAlLavoro.isEmpty {
            Divider()
            Section("Sessioni al lavoro") {
                ForEach(stato.sessioniAlLavoro) { s in
                    Button("\(s.origine) · \(s.etichetta)") { stato.apriFinestra() }
                }
            }
        }

        Divider()
        Button("Riavvia server") { stato.riavviaServer() }
        Button("Mostra log del server") { stato.mostraLog() }
        Button("Apri cartella del cruscotto") { stato.apriCartella() }
        Toggle("Avvia al login", isOn: Binding(get: { stato.avvioAlLogin }, set: { stato.cambiaAvvioAlLogin($0) }))
        Divider()
        Button("Esci") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
