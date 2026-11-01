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
import { Datasets, Experiments } from "../../../components/regression-screens";
import {
  BillingSettings,
  TeamSettings,
  RetentionSettings,
  TeamInvitationAcceptance,
} from "../../../components/commerce-screens";
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
      if (["billing", "usage"].includes(path[1])) return <BillingSettings />;
      if (path[1] === "team") return <TeamSettings />;
      if (path[1] === "retention") return <RetentionSettings />;
      return <Settings />;
    case "team":
      return <TeamInvitationAcceptance />;
    case "datasets":
      return <Datasets />;
    case "experiments":
      return <Experiments />;
    default:
      return <PendingScreen kind="workspace" />;
  }
}
