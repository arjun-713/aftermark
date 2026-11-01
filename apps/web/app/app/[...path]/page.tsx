"use client";
import { usePathname } from "next/navigation";
import {
  Runs,
  RunDetail,
  Reviews,
  Policies,
  Connections,
  Onboarding,
  Settings,
  PendingScreen,
} from "../../../components/screens";
export default function Page() {
  const path = usePathname().split("/").slice(2);
  if (path[0] === "runs" && path[1])
    return <RunDetail runId={decodeURIComponent(path.slice(1).join("/"))} />;
  switch (path[0]) {
    case "runs":
      return <Runs />;
    case "reviews":
      return <Reviews />;
    case "policies":
      return <Policies />;
    case "connections":
      return <Connections />;
    case "onboarding":
      return <Onboarding />;
    case "settings":
      return <Settings />;
    case "datasets":
      return <PendingScreen kind="datasets" />;
    case "experiments":
      return <PendingScreen kind="experiments" />;
    default:
      return <PendingScreen kind="workspace" />;
  }
}
