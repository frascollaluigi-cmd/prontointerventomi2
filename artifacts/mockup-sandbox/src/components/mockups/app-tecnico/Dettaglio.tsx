export default function Dettaglio() {
  return (
    <div className="w-[390px] h-[844px] bg-gray-50 flex flex-col overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Status bar */}
      <div className="flex justify-between items-center px-6 pt-3 pb-1 text-[12px] font-semibold text-white" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #2d5f8a 100%)" }}>
        <span>9:41</span>
        <div className="flex items-center gap-1.5">
          <svg width="17" height="12" viewBox="0 0 17 12" fill="none"><rect x="0" y="3" width="3" height="9" rx="1" fill="white"/><rect x="4.5" y="2" width="3" height="10" rx="1" fill="white"/><rect x="9" y="0" width="3" height="12" rx="1" fill="white"/></svg>
          <div className="w-6 h-3 rounded-sm border border-white/60 flex items-center px-0.5"><div className="w-4 h-1.5 bg-green-400 rounded-xs"></div></div>
        </div>
      </div>

      {/* Header */}
      <div className="px-4 pt-3 pb-5 flex items-center gap-3" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #2d5f8a 100%)" }}>
        <button className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
          <svg width="20" height="20" fill="none" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <span className="text-white font-bold text-base">Intervento #42</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-32">
        {/* Servizio + prezzo */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[#2d5f8a] font-bold text-base">Guasto elettrico</div>
              <div className="text-gray-400 text-xs mt-0.5">⚡ Urgente · entro 90 minuti</div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
            <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">Costo di uscita</span>
            <span className="text-[#2d5f8a] font-black text-xl">€120,00</span>
          </div>
        </div>

        {/* Cliente */}
        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Cliente</div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
          <div className="font-bold text-gray-800 text-sm">Giulia Marchetti</div>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.6 1.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.84a16 16 0 0 0 6.25 6.25l.94-.93a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" stroke="#2d5f8a" strokeWidth="2"/></svg>
            </div>
            <span className="text-[#2d5f8a] font-semibold text-sm">+39 347 123 4567</span>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center flex-shrink-0">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke="#d97706" strokeWidth="2"/><circle cx="12" cy="10" r="3" stroke="#d97706" strokeWidth="2"/></svg>
            </div>
            <div>
              <div className="text-gray-800 text-sm font-medium">Via Torino 18</div>
              <div className="text-gray-400 text-xs">20123 Milano</div>
            </div>
          </div>
        </div>

        {/* Stato */}
        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Stato</div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div>
          <span className="text-gray-800 font-semibold text-sm">Tecnico assegnato</span>
        </div>

        {/* Note */}
        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Note cliente</div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <p className="text-gray-600 text-sm leading-relaxed">"Blackout totale nell'appartamento al 3° piano. Hanno saltato tutti i fusibili."</p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="absolute bottom-0 left-0 right-0 bg-white border-t border-gray-100 px-4 pt-3 pb-6 flex gap-3">
        <button className="flex-1 py-3.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm" style={{ backgroundColor: "#22c55e" }}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span className="text-white">Accetta</span>
        </button>
        <button className="flex-1 py-3.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm bg-gray-100">
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" stroke="#374151" strokeWidth="2.5" strokeLinecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="#374151" strokeWidth="2.5" strokeLinecap="round"/></svg>
          <span className="text-gray-700">Rifiuta</span>
        </button>
        <button className="flex-1 py-3.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm" style={{ background: "linear-gradient(135deg, #1e3a5f, #2d5f8a)" }}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span className="text-white">Fatto</span>
        </button>
      </div>

      {/* Home indicator */}
      <div className="flex justify-center pb-2 pt-20">
        <div className="w-28 h-1 bg-gray-300 rounded-full"></div>
      </div>
    </div>
  );
}
