import { Composer } from "./Composer";
import { Header } from "./Header";
import { Toasts } from "./Toasts";
import { Transcript } from "./Transcript";
import { WorkingIndicator } from "./WorkingIndicator";

export function App() {
  return (
    <div class="app">
      <Header />
      <Toasts />
      <Transcript />
      <WorkingIndicator />
      <Composer />
    </div>
  );
}
