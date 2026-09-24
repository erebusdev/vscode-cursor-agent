import { useEffect, useRef, useState } from "preact/hooks";
import { hasDroppable, payloadFromDataTransfer } from "../attachments";
import { addAttachment, addToast, focusComposer, useSelector } from "../store";
import { post } from "../vscode";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { SettingsView } from "./SettingsView";
import { Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { UsageView } from "./Usage";
import { WorkingIndicator } from "./WorkingIndicator";

/** Accept file drops anywhere in the view; they become composer attachments. */
function useDropZone() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasDroppable(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasDroppable(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasDroppable(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!e.dataTransfer || !hasDroppable(e.dataTransfer)) return;
      e.preventDefault();
      void payloadFromDataTransfer(e.dataTransfer).then((payload) => {
        for (const a of payload.attachments) addAttachment(a);
        if (payload.uris.length > 0) post({ type: "attachUris", uris: payload.uris });
        else focusComposer();
        if (payload.skipped.length > 0) addToast("info", `Could not attach ${payload.skipped.join(", ")} (binary or larger than 200 KB).`);
      });
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
  return active;
}

export function App() {
  const settingsOpen = useSelector((s) => s.settingsOpen);
  const usageOpen = useSelector((s) => s.usageOpen);
  const dropping = useDropZone();
  return (
    <div class={`app${dropping ? " dropping" : ""}`}>
      {dropping && (
        <div class="drop-overlay" aria-hidden="true">
          <span>Drop to attach</span>
        </div>
      )}
      <Header />
      <Toasts />
      {settingsOpen ? (
        <SettingsView />
      ) : usageOpen ? (
        <UsageView />
      ) : (
        <>
          <Transcript />
          <WorkingIndicator />
          <Composer />
        </>
      )}
    </div>
  );
}
