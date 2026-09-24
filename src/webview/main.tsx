import { render } from "preact";
import type { ExtensionToWebview } from "../shared/protocol";
import { App, isSettingsView } from "./components/App";
import { handleMessage } from "./store";
import { post } from "./vscode";
import { installTooltips } from "./tooltip";
import "./styles.css";

window.addEventListener("message", (e: MessageEvent<ExtensionToWebview>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  handleMessage(msg);
});

const root = document.getElementById("root");
if (root) {
  render(<App />, root);
  installTooltips();
}

post({ type: "ready" });
// The session history is shown by the chat and the history tab.
if (!isSettingsView()) post({ type: "session.list" });
