import { Providers } from "../../components/app-shell";
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
