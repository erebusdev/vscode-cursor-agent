import { useSelector } from "../store";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { SettingsView } from "./SettingsView";
import { Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { UsageView } from "./Usage";
import { WorkingIndicator } from "./WorkingIndicator";

export function App() {
  const settingsOpen = useSelector((s) => s.settingsOpen);
  const usageOpen = useSelector((s) => s.usageOpen);
  return (
    <div class="app">
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
