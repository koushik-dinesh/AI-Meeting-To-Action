export function EmptyState({ title, children }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <h2 className="text-base font-medium text-slate-900">{title}</h2>
      <p className="mt-2 text-sm text-slate-500">{children}</p>
    </div>
  );
}
