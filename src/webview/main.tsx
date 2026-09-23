import { render } from "preact";
import type { ExtensionToWebview } from "../shared/protocol";
import { App } from "./components/App";
import { handleMessage } from "./store";
import { post } from "./vscode";
import "./styles.css";

window.addEventListener("message", (e: MessageEvent<ExtensionToWebview>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  handleMessage(msg);
});

const root = document.getElementById("root");
if (root) {
  render(<App />, root);
}

post({ type: "ready" });
post({ type: "session.list" });
