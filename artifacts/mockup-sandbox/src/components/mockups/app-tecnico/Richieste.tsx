export default function Richieste() {
  const richieste = [
    { id: 42, servizio: "Guasto elettrico", indirizzo: "Via Torino 18, Milano", fascia: "⚡ Urgente · entro 90 min", prezzo: "€120,00", stato: "Assegnata", statoBg: "#dbeafe", statoCol: "#1e40af" },
    { id: 41, servizio: "Salvavita che scatta", indirizzo: "C.so Buenos Aires 55", fascia: "🌙 Serale/Festivo", prezzo: "€200,00", stato: "In corso", statoBg: "#d1fae5", statoCol: "#065f46" },
    { id: 38, servizio: "Citofono guasto", indirizzo: "Via Montenapoleone 8", fascia: "📅 Standard · entro 4h", prezzo: "€120,00", stato: "Completato", statoBg: "#e0e7ff", statoCol: "#3730a3" },
    { id: 35, servizio: "Quadro elettrico", indirizzo: "Via Vittorio Veneto 3", fascia: "📅 Standard · entro 4h", prezzo: "€120,00", stato: "Incassato", statoBg: "#dcfce7", statoCol: "#166534" },
  ];

  return (
    <div className="w-[390px] h-[844px] bg-gray-50 flex flex-col overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Status bar */}
      <div className="flex justify-between items-center px-6 pt-3 pb-1 text-[12px] font-semibold text-white" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #2d5f8a 100%)" }}>
        <span>9:41</span>
        <div className="flex items-center gap-1.5">
          <svg width="17" height="12" viewBox="0 0 17 12" fill="none"><rect x="0" y="3" width="3" height="9" rx="1" fill="white"/><rect x="4.5" y="2" width="3" height="10" rx="1" fill="white"/><rect x="9" y="0" width="3" height="12" rx="1" fill="white"/><rect x="13.5" y="0" width="3" height="12" rx="1" fill="white" opacity="0.4"/></svg>
          <div className="w-6 h-3 rounded-sm border border-white/60 flex items-center px-0.5"><div className="w-4 h-1.5 bg-green-400 rounded-xs"></div></div>
        </div>
      </div>

      {/* Header */}
      <div className="px-5 pt-4 pb-8 flex items-center justify-between" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #2d5f8a 100%)" }}>
        <div>
          <div className="text-white/75 text-xs font-medium">Ciao,</div>
          <div className="text-white font-bold text-xl">Mario Rossi</div>
        </div>
        <button className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="white" strokeWidth="2" strokeLinecap="round"/><polyline points="16 17 21 12 16 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
      </div>

      {/* Stats cards */}
      <div className="px-4 -mt-5 flex gap-2.5 mb-3">
        {[
          { num: "2", lbl: "Attive", col: "#2d5f8a" },
          { num: "8", lbl: "Concluse", col: "#374151" },
          { num: "★ 4.9", lbl: "Rating", col: "#d97706" },
        ].map((s) => (
          <div key={s.lbl} className="flex-1 bg-white rounded-xl py-3 flex flex-col items-center border border-gray-100 shadow-sm">
            <div className="font-bold text-xl" style={{ color: s.col }}>{s.num}</div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mt-0.5">{s.lbl}</div>
          </div>
        ))}
      </div>

      {/* Stripe banner */}
      <div className="mx-4 mb-2 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
        <svg width="15" height="15" fill="none" viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="2" ry="2" stroke="#1a56db" strokeWidth="2"/><line x1="1" y1="10" x2="23" y2="10" stroke="#1a56db" strokeWidth="2"/></svg>
        <span className="text-xs font-semibold text-blue-700">⚠️ Configura pagamenti Stripe →</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2.5">
        {richieste.map((r) => (
          <div key={r.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-gray-900 text-sm truncate">{r.servizio}</div>
                <div className="text-gray-400 text-[11px] mt-0.5 flex items-center gap-1">
                  <svg width="10" height="10" fill="none" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="#9CA3AF" strokeWidth="2"/><circle cx="12" cy="10" r="3" stroke="#9CA3AF" strokeWidth="2"/></svg>
                  {r.indirizzo}
                </div>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full whitespace-nowrap" style={{ backgroundColor: r.statoBg, color: r.statoCol }}>{r.stato}</span>
            </div>
            <div className="flex justify-between items-center pt-2.5 border-t border-gray-100">
              <span className="text-gray-400 text-[11px] font-medium">{r.fascia}</span>
              <span className="text-[#2d5f8a] font-bold text-base">{r.prezzo}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Home indicator */}
      <div className="flex justify-center pb-2 pt-1 bg-gray-50">
        <div className="w-28 h-1 bg-gray-300 rounded-full"></div>
      </div>
    </div>
  );
}
