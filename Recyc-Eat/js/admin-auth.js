// admin-auth.js
// Gate for every page under the admin portal. Without this, the pages render
// their data to anyone who knows the URL, signed in or not.
//
// The markup starts hidden behind body.auth-pending and is only revealed once
// Firebase confirms a signed-in user, so a signed-out visitor never sees kiosk
// figures flash on screen before the redirect.
import { auth, authReady } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const LOGIN_PAGE = "login.html";

function initialsFor(email) {
  const handle = String(email || "").split("@")[0];
  const parts  = handle.split(/[._-]+/).filter(Boolean);
  const mark   = parts.length > 1 ? parts[0][0] + parts[1][0] : handle.slice(0, 2);
  return (mark || "AD").toUpperCase();
}

// swap the placeholder "Admin / EcoNova Staff" for the account actually in use
function showAccount(user) {
  const mark = document.querySelector(".admin-avatar__mark");
  const meta = document.querySelector(".admin-avatar__meta");

  if (mark) mark.textContent = initialsFor(user.email);
  if (!meta) return;

  const name  = meta.querySelector("strong");
  const email = meta.querySelector("span");
  if (name)  name.textContent  = user.displayName || "Admin";
  if (email) email.textContent = user.email || "EcoNova Staff";
}

let signingOut = false;

function redirectToLogin() {
  // replace() so Back can't return to a page that still holds data
  if (signingOut) {
    location.replace(LOGIN_PAGE);
    return;
  }
  // otherwise remember the page, so logging in lands where they were going
  const here = location.pathname.split("/").pop() || "dashboard.html";
  location.replace(`${LOGIN_PAGE}?next=${encodeURIComponent(here)}`);
}

function wireSignOut() {
  const button = document.getElementById("signOutBtn");
  if (!button) return;

  button.addEventListener("click", async () => {
    button.disabled  = true;
    signingOut = true;
    try {
      // the guard below sees the signed-out state and does the redirect
      await signOut(auth);
    } catch (err) {
      console.error("Sign out failed:", err);
      signingOut = false;
      button.disabled = false;
    }
  });
}

wireSignOut();

await authReady;

onAuthStateChanged(auth, (user) => {
  if (!user) {
    redirectToLogin();
    return;
  }
  showAccount(user);
  document.body.classList.remove("auth-pending");
});
