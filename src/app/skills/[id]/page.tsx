import { SkillEditor } from "./skill-editor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <SkillEditor id={(await params).id} />;
}
