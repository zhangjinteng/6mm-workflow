"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Download,
  Save,
  Layers,
  Play,
  FileText,
  Trash2,
  Upload,
  Pencil,
} from "lucide-react";
import type { SkillDetail } from "@/lib/skills";
import type { ModelList } from "@/lib/model-config";
import { request } from "../client";

export function SkillEditor({ id }: { id: string }) {
  const base = "/api/skills/" + id;
  const [skill, setSkill] = useState<SkillDetail | null>(null),
    [markdown, setMarkdown] = useState(""),
    [tab, setTab] = useState("draft");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [resourcePath, setResourcePath] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [fileKey, setFileKey] = useState(0);
  const [editingResource, setEditingResource] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [models, setModels] = useState<ModelList["models"]>([]),
    [modelId, setModelId] = useState(""),
    [modelError, setModelError] = useState("");
  const [version, setVersion] = useState(""),
    [prompt, setPrompt] = useState(""),
    [answer, setAnswer] = useState("");
  const dirty = !!skill && markdown !== skill.markdown;
  useEffect(() => {
    let live = true;
    request<SkillDetail>(base)
      .then((v) => {
        if (live) {
          setSkill(v);
          setMarkdown(v.markdown);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [base]);
  useEffect(() => {
    if (tab !== "try") return;
    let live = true;
    request<ModelList>("/api/models")
      .then((v) => {
        if (!live) return;
        const rows = v.models.filter(
          (m) => m.type === "llm" && m.isActive && !m.deletedAt,
        );
        setModels(rows);
        setModelId((old) =>
          rows.some((m) => m.id === old)
            ? old
            : (rows.find((m) => m.isDefault) || rows[0])?.id || "",
        );
        setModelError("");
      })
      .catch((e) => {
        if (live) setModelError(e.message);
      });
    return () => {
      live = false;
    };
  }, [tab]);
  useEffect(() => {
    if (!dirty) return;
    function unload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    function leave(e: MouseEvent) {
      if (
        e.target instanceof Element &&
        e.target.closest("a[href]:not([download])") &&
        !confirm("草稿尚未保存，确认离开？")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", leave, true);
    };
  }, [dirty]);
  function apply(s: SkillDetail) {
    setSkill(s);
    setMarkdown(s.markdown);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saved() {
    if (!skill) throw Error("请重新打开 Skill");
    if (!dirty) return skill;
    const s = await request<SkillDetail>(base, "PATCH", {
      revision: skill.revision,
      markdown,
    });
    apply(s);
    return s;
  }
  async function changeVersion(number?: number) {
    if (!skill) return;
    const s = number === undefined ? await saved() : skill;
    await request(base + "/versions", "POST", { revision: s.revision, number });
    apply(await request<SkillDetail>(base));
    setNotice(number ? "已切换生效版本" : "已发布当前草稿");
  }
  const resourceUrl = (path: string, rev?: number) =>
    base +
    "/resources?path=" +
    encodeURIComponent(path) +
    (rev ? "&revision=" + rev : "");
  return (
    <>
      <Link className="inline-link" href="/skills">
        <ArrowLeft size={14} />
        Skill 管理
      </Link>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="skill-notice">
          {notice}
        </p>
      )}
      {!skill ? (
        <p className="skill-empty">{error ? "无法打开 Skill" : "正在加载…"}</p>
      ) : (
        <>
          <div className="page-heading skill-editor-heading">
            <div>
              <h1>{skill.name}</h1>
              <p>{skill.description}</p>
            </div>
            <div className="skill-actions">
              <a download className="button secondary" href={base + "/export"}>
                <Download size={15} />
                导出草稿
              </a>
              <button
                className="button primary"
                disabled={busy || (!dirty && !skill.dirty)}
                onClick={() => void act(() => changeVersion())}
              >
                <Layers size={15} />
                发布版本
              </button>
            </div>
          </div>
          <div className="list-heading">
            <div className="view-tabs">
              {[
                ["draft", "草稿"],
                ["files", "资源"],
                ["versions", "版本"],
                ["try", "模型试跑"],
              ].map(([v, label]) => (
                <button
                  key={v}
                  className={tab === v ? "active" : ""}
                  onClick={() => setTab(v)}
                  disabled={busy}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {tab === "draft" && (
            <section className="skill-panel">
              <div className="skill-panel-head">
                <h2>
                  <FileText size={17} />
                  SKILL.md
                </h2>
                <span>
                  {dirty
                    ? "有未保存的修改"
                    : skill.dirty
                      ? "已保存草稿"
                      : "与当前版本一致"}
                </span>
              </div>
              <textarea
                className="skill-code"
                aria-label="SKILL.md"
                spellCheck={false}
                disabled={busy}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
              />
              <div className="skill-panel-foot">
                <button
                  className="button secondary"
                  disabled={busy || !dirty}
                  onClick={() =>
                    void act(async () => {
                      await saved();
                      setNotice("草稿已保存");
                    })
                  }
                >
                  <Save size={14} />
                  保存草稿
                </button>
              </div>
            </section>
          )}
          {tab === "files" && (
            <section className="skill-panel">
              <h2>资源文件</h2>
              <p className="skill-help">
                同路径上传会替换草稿中的文件，已发布版本保留原件。
              </p>
              <div className="skill-fields">
                <label>
                  选择文件
                  <input
                    key={fileKey}
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      setFile(f);
                      if (f && !resourcePath) setResourcePath(f.name);
                    }}
                  />
                </label>
                <label>
                  包内路径
                  <input
                    placeholder="references/example.md"
                    value={resourcePath}
                    onChange={(e) => setResourcePath(e.target.value)}
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={!file || !resourcePath.trim() || busy}
                  onClick={() =>
                    void act(async () => {
                      const s = await saved();
                      apply(
                        await request<SkillDetail>(
                          resourceUrl(resourcePath.trim(), s.revision),
                          "PUT",
                          file,
                        ),
                      );
                      setFile(null);
                      setFileKey((k) => k + 1);
                      setResourcePath("");
                      setNotice("资源已保存");
                    })
                  }
                >
                  <Upload size={14} />
                  保存资源
                </button>
              </div>
              {skill.resources.length === 0 ? (
                <p className="skill-help">草稿中暂无资源。</p>
              ) : (
                skill.resources.map((f) => (
                  <div className="skill-line" key={f.path}>
                    <a download href={resourceUrl(f.path)}>
                      {f.path}
                    </a>
                    <small>{f.size.toLocaleString()} B</small>
                    {/\.(md|txt|csv|json|ya?ml|toml|xml|html|css|js|ts|py|sh)$/i.test(
                      f.path,
                    ) &&
                      f.size <= 256 * 1024 && (
                        <button
                          className="icon-button"
                          aria-label={"编辑资源 " + f.path}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const res = await fetch(resourceUrl(f.path));
                              if (!res.ok) throw Error("无法读取资源");
                              setEditingResource({
                                path: f.path,
                                text: new TextDecoder("utf-8", {
                                  fatal: true,
                                }).decode(await res.arrayBuffer()),
                              });
                            })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                    <button
                      className="icon-button"
                      aria-label={"删除资源 " + f.path}
                      disabled={busy}
                      onClick={() => {
                        if (confirm("从草稿中删除 " + f.path + "？"))
                          void act(async () => {
                            const s = await saved();
                            apply(
                              await request<SkillDetail>(
                                resourceUrl(f.path, s.revision),
                                "DELETE",
                              ),
                            );
                          });
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))
              )}
              {editingResource && (
                <div className="skill-fields">
                  <label>
                    {editingResource.path}
                    <textarea
                      aria-label="资源内容"
                      rows={9}
                      value={editingResource.text}
                      onChange={(e) =>
                        setEditingResource({
                          ...editingResource,
                          text: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="skill-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setEditingResource(null)}
                    >
                      取消编辑
                    </button>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const s = await saved();
                          apply(
                            await request<SkillDetail>(
                              resourceUrl(editingResource.path, s.revision),
                              "PUT",
                              new Blob([editingResource.text]),
                            ),
                          );
                          setEditingResource(null);
                          setNotice("资源内容已保存");
                        })
                      }
                    >
                      保存资源内容
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
          {tab === "versions" && (
            <section className="skill-panel">
              <h2>发布历史</h2>
              <p className="skill-help">切换生效版本会保留当前草稿。</p>
              {!skill.history.length ? (
                <p>还没有已发布版本。</p>
              ) : (
                [...skill.history].reverse().map((v) => (
                  <div className="skill-line" key={v.number}>
                    <strong>v{v.number}</strong>
                    {skill.active === v.number && (
                      <span className="skill-tag live">当前版本</span>
                    )}
                    <small>{new Date(v.at).toLocaleString("zh-CN")}</small>
                    <a
                      download
                      className="inline-link"
                      href={base + "/export?version=" + v.number}
                    >
                      导出
                    </a>
                    {skill.active !== v.number && (
                      <button
                        className="button secondary"
                        disabled={busy || dirty}
                        onClick={() => void act(() => changeVersion(v.number))}
                      >
                        切换至此版本
                      </button>
                    )}
                  </div>
                ))
              )}
            </section>
          )}
          {tab === "try" && (
            <section className="skill-panel skill-fields">
              <h2>模型试跑</h2>
              <p className="skill-help">
                将所选版本的 SKILL.md 和测试输入发送给模型。资源脚本不会执行。
              </p>
              <label>
                试跑版本
                <select
                  value={version}
                  onChange={(e) => {
                    setVersion(e.target.value);
                    setAnswer("");
                  }}
                >
                  <option value="">当前草稿</option>
                  {skill.history.map((v) => (
                    <option key={v.number} value={v.number}>
                      v{v.number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                语言模型
                <select
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    setAnswer("");
                  }}
                >
                  {!models.length && <option value="">暂无可用语言模型</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.upstreamModel}
                    </option>
                  ))}
                </select>
              </label>
              {modelError && <p role="alert">{modelError}</p>}
              <label>
                测试输入
                <textarea
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !modelId || !prompt.trim()}
                onClick={() =>
                  void act(async () => {
                    setAnswer("");
                    const s = version ? skill : await saved();
                    const res = await request<{ text: string }>(
                      base + "/try",
                      "POST",
                      {
                        modelId,
                        revision: s.revision,
                        version: version ? Number(version) : undefined,
                        input: prompt,
                      },
                    );
                    setAnswer(res.text);
                  })
                }
              >
                <Play size={15} />
                {busy ? "正在试跑…" : "开始试跑"}
              </button>
              {answer && (
                <div className="skill-result" role="status">
                  <h2>模型回复</h2>
                  <pre>{answer}</pre>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
