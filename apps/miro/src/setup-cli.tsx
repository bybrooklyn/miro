import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SetupScreen } from "./setup/SetupScreen";

const renderer = await createCliRenderer();
createRoot(renderer).render(<SetupScreen />);
