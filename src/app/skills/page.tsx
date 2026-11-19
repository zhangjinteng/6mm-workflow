"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Upload,
  Search,
  FilePenLine,
  Layers,
  RefreshCw,
  Copy,
  Trash2,
  ArrowUpRight,
  X,
} from "lucide-react";
import type { SkillSummary } from "@/lib/skills";
import { request } from "./client";

export default function SkillsPage() {
  const router = useRouter();
  const [items, setItems] = useState<SkillSummary[]>([]),
    [query, setQuery] = useState(""),
    [scope, setScope] = useState("all");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const picker = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let live = true;
    request<SkillSummary[]>("/api/skills")
      .then((rows) => {
        if (live) setItems(rows);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (creating) dialog.current?.showModal();
  }, [creating]);
  async function reload() {
    setItems(await request<SkillSummary[]>("/api/skills"));
  }
  async function act(work: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = items.filter(
    (s) =>
      (scope === "all" ||
        (scope === "published" ? s.active !== null : s.active === null)) &&
      (s.name + " " + s.description)
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE / SKILLS</div>
          <h1>
            Skill 管理 <span>{items.length}</span>
          </h1>
        </div>
        <div className="skill-actions">
          <input
            hidden
            ref={picker}
            type="file"
            accept=".zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void act(async () => {
                  const added = await request<SkillSummary[]>(
                    "/api/skills/import",
                    "POST",
                    file,
                  );
                  await reload();
                  setNotice("已导入 " + added.length + " 个 Skill");
                  if (added.length === 1) router.push("/skills/" + added[0].id);
                });
            }}
          />
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            <Upload size={15} />
            导入 ZIP
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              setName("");
              setDescription("");
              setError("");
              setCreating(true);
            }}
          >
            <Plus size={16} />
            新建 Skill
          </button>
        </div>
      </div>
      <div className="summary-band">
        <div>
          <span className="summary-icon">
            <BookOpen size={17} />
          </span>
          <span>
            全部 Skill<strong>{items.length}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon teal">
            <Layers size={17} />
          </span>
          <span>
            已发布<strong>{items.filter((s) => s.active).length}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon amber">
            <FilePenLine size={17} />
          </span>
          <span>
            待发布草稿<strong>{items.filter((s) => s.dirty).length}</strong>
          </span>
        </div>
      </div>
      {error && !creating && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="skill-notice">
          {notice}
        </p>
      )}
      <div className="list-heading">
        <div className="view-tabs">
          {[
            ["all", "全部"],
            ["published", "已发布"],
            ["draft", "未发布"],
          ].map(([v, label]) => (
            <button
              key={v}
              className={scope === v ? "active" : ""}
              onClick={() => setScope(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          aria-label="刷新 Skill"
          className="icon-button"
          disabled={busy}
          onClick={() => void act(reload)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="filter-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索 Skill"
            placeholder="搜索名称或描述"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="skill-list">
        <table>
          <thead>
            <tr>
              <th>Skill 名称 / 描述</th>
              <th>当前版本</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={"/skills/" + s.id}>
                    <BookOpen size={17} />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.description}</small>
                    </span>
                  </Link>
                </td>
                <td>
                  <span className={s.active ? "skill-tag live" : "skill-tag"}>
                    {s.active ? "v" + s.active : "草稿"}
                  </span>
                  {s.active && s.dirty ? " · 有草稿" : ""}
                </td>
                <td>{new Date(s.updatedAt).toLocaleString("zh-CN")}</td>
                <td>
                  <div className="skill-actions">
                    <Link
                      aria-label={"编辑 " + s.name}
                      href={"/skills/" + s.id}
                      className="icon-button"
                    >
                      <ArrowUpRight size={16} />
                    </Link>
                    <button
                      disabled={busy}
                      className="icon-button"
                      aria-label={"复制 " + s.name}
                      onClick={() =>
                        void act(async () => {
                          const copy = await request<SkillSummary>(
                            "/api/skills/" + s.id + "/copy",
                            "POST",
                          );
                          router.push("/skills/" + copy.id);
                        })
                      }
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      disabled={busy}
                      aria-label={"删除 " + s.name}
                      className="icon-button"
                      onClick={() => {
                        if (confirm("删除「" + s.name + "」及其所有版本？"))
                          void act(async () => {
                            await request(
                              "/api/skills/" + s.id + "?revision=" + s.revision,
                              "DELETE",
                            );
                            await reload();
                          });
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="skill-empty">
            <BookOpen size={28} />
            <h2>
              {loading
                ? "正在读取 Skill…"
                : error
                  ? "列表暂时不可用"
                  : items.length
                    ? "没有匹配的 Skill"
                    : "还没有 Skill"}
            </h2>
            {!loading && !error && (
              <p>
                {items.length
                  ? "调整搜索词或筛选条件。"
                  : "新建一份说明，或导入包含 SKILL.md 的 ZIP 包。"}
              </p>
            )}
          </div>
        )}
      </div>
      {creating && (
        <dialog
          ref={dialog}
          className="model-dialog"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setCreating(false);
          }}
          aria-label="新建 Skill"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const markdown =
                  "---\nname: " +
                  JSON.stringify(name.trim()) +
                  "\ndescription: " +
                  JSON.stringify(description) +
                  "\n---\n\n# 使用说明\n\n";
                const s = await request<SkillSummary>("/api/skills", "POST", {
                  markdown,
                });
                setCreating(false);
                router.push("/skills/" + s.id);
              });
            }}
          >
            <div className="dialog-heading">
              <h2>新建 Skill</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="skill-fields">
              <label>
                名称
                <input
                  autoFocus
                  required
                  maxLength={128}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                描述
                <textarea
                  rows={3}
                  maxLength={4096}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer className="dialog-footer">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
              >
                创建草稿
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </>
  );
}
