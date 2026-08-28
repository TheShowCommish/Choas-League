import { redirect } from "next/navigation";

// The middleware already bounces signed-out visitors to /login, so
// anyone reaching here has a session.
export default function Home() {
  redirect("/leagues");
}
