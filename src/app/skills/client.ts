export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const bytes = body instanceof Blob;
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": bytes
              ? "application/octet-stream"
              : "application/json",
          },
    body: body === undefined ? undefined : bytes ? body : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "请求失败");
  return json.data;
}
