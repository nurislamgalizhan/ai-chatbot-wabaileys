import "@fontsource-variable/manrope";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// check.<domain> is the chief's read-only view; everything else is the
// managers' cabinet. Each is its own chunk: neither downloads the other.
const isCheck = window.location.hostname.startsWith("check.");
// Two separate dynamic imports: one combined import() would make the
// bundler preload BOTH chunks on either host.
const Root = isCheck ? lazy(() => import("./check/CheckApp")) : lazy(() => import("./App"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
