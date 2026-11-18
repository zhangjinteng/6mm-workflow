/** 返回服务健康状态，供本地启动验证和后续部署探活使用。 */
export function GET() {
  return Response.json({ status: "ok", service: "zjt-workflow" });
}
