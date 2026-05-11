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

export function useApi() {
  const config = useRuntimeConfig();
  const baseURL = config.public.apiBase.replace(/\/$/, "");

  async function api<T>(path: string, options: Parameters<typeof $fetch>[1] = {}) {
    return $fetch<T>(path, { baseURL, ...options });
  }

  async function upload<T>(path: string, body: FormData, options: UploadOptions = {}) {
    const method = options.method ?? "POST";
    if (typeof XMLHttpRequest === "undefined") {
      return api<T>(path, { method, body });
    }

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `${baseURL}${path}`);

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
