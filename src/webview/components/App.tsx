import { useSelector } from "../store";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { SettingsView } from "./SettingsView";
import { Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { WorkingIndicator } from "./WorkingIndicator";

export function App() {
  const settingsOpen = useSelector((s) => s.settingsOpen);
  return (
    <div class="app">
      <Header />
      <Toasts />
      {settingsOpen ? (
        <SettingsView />
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
