const features = ["Next.js App Router", "TypeScript", "Tailwind CSS", "ESLint"];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16 sm:px-12">
      <div className="mb-12 flex items-center gap-3 font-semibold tracking-tight">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white">Z</span>
        ZJT Workflow
      </div>
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-14">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-sm text-emerald-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          开发环境已就绪
        </div>
        <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">从这里开始，构建你的工作流。</h1>
        <p className="mt-5 max-w-xl text-base leading-8 text-slate-500">项目基础框架已搭建完成。现在可以开始添加页面、编写业务逻辑，并将你的想法变成应用。</p>
        <div className="mt-8 flex flex-wrap gap-2">
          {features.map((feature) => (
            <span key={feature} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">{feature}</span>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap gap-4">
          <a href="/api/health" className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700">检查服务状态 →</a>
          <a href="https://nextjs.org/docs" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-medium transition hover:bg-slate-50">查看开发文档 ↗</a>
        </div>
      </section>
      <footer className="mt-8 text-sm text-slate-400">ZJT Workflow · Ready to build</footer>
    </main>
  );
}
