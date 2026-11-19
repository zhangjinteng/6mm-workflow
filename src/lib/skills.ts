export type SkillVersion = { number: number; archive: string; at: string };
export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  active: number | null;
  versions: number;
  dirty: boolean;
};
export type SkillDetail = SkillSummary & {
  markdown: string;
  resources: { path: string; size: number }[];
  history: { number: number; at: string }[];
};
