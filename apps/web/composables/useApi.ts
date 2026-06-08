export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
  lengthComputable: boolean;
}

interface UploadOptions {
  method?: "POST" | "PUT" | "PATCH";
  onProgress?: (progress: UploadProgress) => void;
}

const AUTH_COOKIE_NAME = "mcsa_token";

function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

function getCookieToken(): string | undefined {
  if (typeof document === "undefined") {
    return getCookieValue(useRequestHeaders(["cookie"]).cookie, AUTH_COOKIE_NAME);
  }
  return getCookieValue(document.cookie, AUTH_COOKIE_NAME);
}

export function useApi() {
  const config = useRuntimeConfig();
  const baseURL = (typeof document === "undefined" ? config.apiBase : config.public.apiBase).replace(/\/$/, "");

  async function api<T>(path: string, options: Parameters<typeof $fetch>[1] = {}) {
    const token = getCookieToken();
    const cookie = typeof document === "undefined" ? useRequestHeaders(["cookie"]).cookie : undefined;
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie && !headers.cookie) headers.cookie = cookie;
    return $fetch<T>(path, { baseURL, ...options, headers });
  }

  async function upload<T>(path: string, body: FormData, options: UploadOptions = {}) {
    const method = options.method ?? "POST";
    if (typeof XMLHttpRequest === "undefined") {
      return api<T>(path, { method, body });
    }

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${baseURL}${path}`);

      const token = getCookieToken();
      if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);

      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : 0;
        const percent = total > 0 ? Math.min(99, Math.round((event.loaded / total) * 100)) : 0;
        options.onProgress?.({ loaded: event.loaded, total, percent, lengthComputable: event.lengthComputable });
      };

      xhr.onload = () => {
        const data = parseUploadResponse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          options.onProgress?.({ loaded: 1, total: 1, percent: 100, lengthComputable: true });
          resolve(data as T);
          return;
        }
        reject(createUploadError(data, xhr.statusText || `HTTP ${xhr.status}`));
      };

      xhr.onerror = () => reject(new Error("Failed to fetch"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      xhr.send(body);
    });
  }

  function parseUploadResponse(responseText: string) {
    if (!responseText) return null;
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return responseText;
    }
  }

  function createUploadError(data: unknown, fallback: string) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : fallback;
    return Object.assign(new Error(message), { data });
  }

  function downloadUrl(path: string) {
    return `${baseURL}${path}`;
  }

  return { api, upload, downloadUrl, baseURL };
}
