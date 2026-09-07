import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Summonable fullscreen twin of the desk, for when windows cover the
// wallpaper. Bind e.g. SUPER+D → `omarchy-shell shell toggle nixfred.infomarchy`.
// Esc or a click outside the cards closes it.
Scope {
  id: root
  property bool opened: false
  // Same single output as the desk (Infomarchy.qml): the cards, the wallpaper
  // and the keyboard grab all belong to one screen.
  //
  // The panel itself still exists on the others, as a transparent click
  // catcher. Dropping it entirely looked right and was a trap: the layer's
  // keyboard focus is Exclusive, which is a *global* grab rather than a
  // per-output one, so with the overlay open on the laptop no window on any
  // screen receives a key. The only ways out were Esc on the overlay's own
  // screen or a click on the overlay itself — and on the screen the user was
  // actually working on there was nothing to click and nothing to explain the
  // silence. Every window looked frozen. A click anywhere closes it again,
  // and the other screens say so rather than swallowing input mutely.
  readonly property string deskScreenName: {
    var want = Quickshell.env("INFOMARCHY_SCREEN") || "eDP-1"
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++) if (screens[i].name === want) return want
    return screens.length > 0 ? screens[0].name : ""
  }

  InfoModel { id: infoModel; refreshMs: 3000; active: root.opened; instance: "overlay"; demoMode: demoMarker.present }
  InfoSettings { id: dashboardSettings }
  // Demo mode is set on the wallpaper service; a screenshot taken with the
  // overlay open must not leak live prompts. Mirror the runtime marker.
  FileView {
    id: demoMarker
    property bool present: false
    path: (Quickshell.env("XDG_RUNTIME_DIR") || ("/run/user/" + Quickshell.env("UID"))) + "/infomarchy-demo"
    watchChanges: true
    printErrors: false
    onLoaded: present = true
    onLoadFailed: present = false
    onFileChanged: reload()
  }

  // SUPER+D means "show me the desktop": the real wallpaper, dimmed exactly as
  // the background layer dims it, with the dashboard on top only when SUPER+I
  // has it visible. The old 88% theme-colour scrim hid the wallpaper photo and
  // ignored SUPER+I, so toggling the dashboard while the overlay was open
  // changed the desk underneath without changing what was on screen.
  property string background: ""
  readonly property real wallpaperOpacity: 0.32
  Process {
    id: backgroundLink
    command: ["readlink", "-f", Quickshell.env("HOME") + "/.local/state/omarchy/current/background"]
    stdout: StdioCollector { onStreamFinished: root.background = String(text || "").trim() }
  }
  function open(payload) {
    root.opened = true
    backgroundLink.running = true
    demoMarker.reload()
    infoModel.refresh()
  }
  function close() { root.opened = false }
  function toggle(payload) { if (root.opened) close(); else open(payload) }
  // `omarchy-shell shell call nixfred.infomarchy refresh` hits the overlay
  // loader, not the wallpaper IpcHandler.
  function refresh() { infoModel.refresh() }

  Variants {
    model: Quickshell.screens
    PanelWindow {
      id: panel
      required property var modelData
      readonly property bool isDeskScreen: modelData.name === root.deskScreenName
      screen: modelData
      visible: root.opened && !remapGuard.remapping
      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      WlrLayershell.namespace: "infomarchy-overlay"
      WlrLayershell.layer: WlrLayer.Overlay
      // One grab, on the screen that draws the cards. The catchers ask for
      // nothing: two surfaces claiming an exclusive grab is undefined.
      WlrLayershell.keyboardFocus: root.opened && panel.isDeskScreen ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      ScreenMoveRemap {
        id: remapGuard
        window: panel
      }

      Rectangle {
        id: keyCatcher
        anchors.fill: parent
        color: panel.isDeskScreen ? infoModel.themeBackground : "transparent"
        Image {
          anchors.fill: parent
          visible: panel.isDeskScreen
          source: Util.fileUrl(root.background)
          fillMode: Image.PreserveAspectCrop
          asynchronous: true
          cache: true
          opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0
          Behavior on opacity { NumberAnimation { duration: 300 } }
        }
        focus: root.opened && panel.isDeskScreen
        Keys.onEscapePressed: root.close()
        Keys.onPressed: function(event) {
          if (event.key >= Qt.Key_0 && event.key <= Qt.Key_9) { var i = event.key === Qt.Key_0 ? 9 : event.key - Qt.Key_1; var def = dashboardSettings.definitions[i]; if (def) dashboardSettings.toggleSection(def.id); event.accepted = true; return }
          if (event.key === Qt.Key_J || event.key === Qt.Key_Down) { infoView.keyboardStep(1); event.accepted = true; return }
          if (event.key === Qt.Key_K || event.key === Qt.Key_Up) { infoView.keyboardStep(-1); event.accepted = true; return }
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { infoView.activateKeyboardSession(); event.accepted = true; return }
          if (event.key === Qt.Key_A) { infoView.clearActivityFilter(); event.accepted = true }
        }
        // Exclusive keyboard focus on the layer is not enough — Qt still
        // needs an item with activeFocus or Esc never fires.
        onVisibleChanged: if (visible && panel.isDeskScreen) Qt.callLater(function() { keyCatcher.forceActiveFocus() })
        MouseArea { anchors.fill: parent; onClicked: root.close() }
        // The one thing drawn on the other screens. A transparent layer that
        // eats clicks and keys with no explanation reads as a frozen desktop,
        // which is exactly how this failed.
        Text {
          anchors.centerIn: parent
          visible: !panel.isDeskScreen
          text: "infomarchy overlay · click or Esc to close"
          color: infoModel.themeForeground
          opacity: 0.55
          font.family: Style.resolvedFontFamily
          font.pixelSize: Style.font.body
          renderType: Text.NativeRendering
        }
        InfoView {
          id: infoView
          anchors.fill: parent
          desk: infoModel
          settings: dashboardSettings
          interactive: true
          topInset: Style.spacing.xl
          // SUPER+I applies here too: hidden dashboard = plain wallpaper, same as the desk.
          visible: panel.isDeskScreen && dashboardSettings.ready && dashboardSettings.dashboardVisible
          onNavigated: root.close()
        }
      }
    }
  }
}
