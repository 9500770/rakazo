import type { SavedSignIn } from "./config.js";

/**
 * The two server calls this agent needs beyond the device socket: a sign-in to pair with, and the
 * pairing itself. Both are the same endpoints the desktop app uses, with a cookie instead of an
 * Electron session. Nothing here needs a server change.
 */
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const GET_SESSION_PATH = "/api/auth/get-session";
const PAIR_PATH = "/api/devices/pair";
const DEVICES_PATH = "/api/devices";
const REQUEST_TIMEOUT_MS = 20_000;
const SIGN_IN_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;

export class SignInError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export interface SessionUser {
  userId: string;
  email: string | null;
}

export interface PairedToken {
  deviceId: string;
  userId: string;
  token: string;
}

/**
 * Better Auth rejects a browser-shaped POST that carries no Origin ("Missing or null Origin"), and a
 * script sends none by itself; the desktop app gets one for free from its renderer. Every call here
 * therefore names the server as its own origin.
 */
function request(serverUrl: string, path: string, init: RequestInit = {}) {
  const origin = new URL(serverUrl).origin;
  const headers = { origin, referer: `${origin}/`, ...(init.headers ?? {}) };
  return fetch(new URL(path, serverUrl), {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers,
  });
}

async function failure(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const parsed = typeof body.message === "string" ? body.message : body.error;
    if (typeof parsed === "string" && parsed) message = parsed;
  } catch {
    /* Not JSON: the body text is all there is. */
  }
  throw new SignInError(message.slice(0, 300) || `Request failed (${response.status})`, response.status);
}

/** Cookie pairs only: attributes (Path, Expires…) are dropped, and a sign-in has a handful. */
export function cookieFromSetCookie(headers: string[]): { cookie: string; expiresAt: string } | null {
  const pairs: string[] = [];
  let expires = 0;
  for (const header of headers) {
    const pair = header.split(";", 1)[0]?.trim();
    if (!pair || !pair.includes("=")) continue;
    pairs.push(pair);
    const rest = header.slice(pair.length);
    const expiresMatch = /;\s*expires=([^;]+)/i.exec(rest);
    const maxAgeMatch = /;\s*max-age=(\d+)/i.exec(rest);
    if (maxAgeMatch) expires = Math.max(expires, Date.now() + Number(maxAgeMatch[1]) * 1000);
    else if (expiresMatch?.[1]) {
      const at = Date.parse(expiresMatch[1]);
      if (Number.isFinite(at)) expires = Math.max(expires, at);
    }
  }
  if (!pairs.length) return null;
  return {
    cookie: pairs.join("; "),
    expiresAt: new Date(expires || Date.now() + SIGN_IN_LIFETIME_MS).toISOString(),
  };
}

export async function signIn(
  serverUrl: string,
  email: string,
  password: string,
): Promise<SavedSignIn> {
  const response = await request(serverUrl, SIGN_IN_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      await response.body?.cancel();
      throw new SignInError("Too many sign-in attempts. Wait a few minutes and try again.", 429);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new SignInError("Wrong email or password", response.status);
    }
    await failure(response);
  }
  const saved = cookieFromSetCookie(response.headers.getSetCookie());
  await response.body?.cancel();
  if (!saved) throw new SignInError("The server did not keep this sign-in", 502);
  return saved;
}

export async function sessionUser(serverUrl: string, cookie: string): Promise<SessionUser | null> {
  const response = await request(serverUrl, GET_SESSION_PATH, {
    headers: { cookie, accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    user?: { id?: unknown; email?: unknown };
    session?: { userId?: unknown };
  } | null;
  const userId = body?.session?.userId ?? body?.user?.id;
  if (typeof userId !== "string" || !userId) return null;
  return { userId, email: typeof body?.user?.email === "string" ? body.user.email : null };
}

export async function pairDevice(
  serverUrl: string,
  cookie: string,
  name: string,
  platform = process.platform,
): Promise<PairedToken> {
  const reported = platform === "darwin" || platform === "win32" ? platform : "linux";
  const response = await request(serverUrl, PAIR_PATH, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name, platform: reported }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      await response.body?.cancel();
      throw new SignInError("The sign-in expired before this computer could pair", 401);
    }
    if (response.status === 409) {
      await response.body?.cancel();
      throw new SignInError("The account already has as many computers as it allows", 409);
    }
    await failure(response);
  }
  const body = (await response.json().catch(() => null)) as {
    deviceId?: unknown;
    userId?: unknown;
    token?: unknown;
  } | null;
  if (
    typeof body?.deviceId !== "string" ||
    typeof body?.token !== "string" ||
    typeof body?.userId !== "string"
  ) {
    throw new SignInError("The server returned an unexpected pairing", 502);
  }
  return { deviceId: body.deviceId, userId: body.userId, token: body.token };
}

/**
 * One cheap authenticated call keeps the pairing's sign-in rolling, so the computer is never
 * disconnected for inactivity. Returns the refreshed cookie when the server rotates it.
 */
export async function refreshSignIn(
  serverUrl: string,
  cookie: string,
): Promise<{ alive: false } | { alive: true; signIn: SavedSignIn }> {
  const response = await request(serverUrl, DEVICES_PATH, {
    headers: { cookie, accept: "application/json" },
  });
  await response.body?.cancel();
  if (response.status === 401) return { alive: false };
  if (!response.ok) throw new SignInError(`Session check failed (${response.status})`, response.status);
  const rotated = cookieFromSetCookie(response.headers.getSetCookie());
  return {
    alive: true,
    signIn: rotated ?? { cookie, expiresAt: new Date(Date.now() + SIGN_IN_LIFETIME_MS).toISOString() },
  };
}

/** Best effort: a token that cannot be dropped locally must not stay valid on the server. */
export async function revokeDevice(serverUrl: string, token: string): Promise<boolean> {
  try {
    const response = await request(serverUrl, `${DEVICES_PATH}/self`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    await response.body?.cancel();
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}
