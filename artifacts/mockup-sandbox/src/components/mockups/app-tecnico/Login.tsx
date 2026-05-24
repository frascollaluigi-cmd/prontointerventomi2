export default function Login() {
  return (
    <div className="w-[390px] h-[844px] bg-white flex flex-col overflow-hidden font-sans" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Status bar */}
      <div className="flex justify-between items-center px-6 pt-3 pb-1 text-[12px] font-semibold text-gray-800">
        <span>9:41</span>
        <div className="flex items-center gap-1">
          <svg width="17" height="12" viewBox="0 0 17 12" fill="none"><rect x="0" y="3" width="3" height="9" rx="1" fill="#1C1C1E"/><rect x="4.5" y="2" width="3" height="10" rx="1" fill="#1C1C1E"/><rect x="9" y="0" width="3" height="12" rx="1" fill="#1C1C1E"/><rect x="13.5" y="0" width="3" height="12" rx="1" fill="#1C1C1E"/></svg>
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none"><path d="M8 2.4C10.3 2.4 12.4 3.4 13.8 5L15.2 3.5C13.4 1.5 10.8 0.3 8 0.3C5.2 0.3 2.6 1.5 0.8 3.5L2.2 5C3.6 3.4 5.7 2.4 8 2.4Z" fill="#1C1C1E"/><path d="M8 5.6C9.5 5.6 10.9 6.2 11.9 7.2L13.3 5.7C11.9 4.4 10 3.6 8 3.6C6 3.6 4.1 4.4 2.7 5.7L4.1 7.2C5.1 6.2 6.5 5.6 8 5.6Z" fill="#1C1C1E"/><circle cx="8" cy="10" r="2" fill="#1C1C1E"/></svg>
          <div className="flex items-center gap-0.5">
            <div className="w-6 h-3 rounded-sm border border-gray-700 flex items-center px-0.5"><div className="w-4 h-1.5 bg-green-500 rounded-xs"></div></div>
          </div>
        </div>
      </div>

      {/* Header gradient */}
      <div className="px-6 pt-8 pb-10" style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #2d5f8a 100%)" }}>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
            <span className="text-white text-lg font-black">P</span>
          </div>
          <div>
            <div className="text-white font-bold text-lg leading-tight">ProntoIntervento</div>
            <div className="text-white/60 text-xs">by ELETTROTECH · Area Tecnici</div>
          </div>
        </div>
        <div className="mt-4 text-white/80 text-sm">Accedi al pannello tecnico</div>
      </div>

      {/* Form card */}
      <div className="flex-1 px-5 -mt-5">
        <div className="bg-white rounded-2xl shadow-xl p-6 border border-gray-100">
          <div className="text-gray-800 font-bold text-lg mb-5">Accedi</div>

          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Email</div>
            <div className="border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-2 bg-gray-50">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="#9CA3AF" strokeWidth="2"/><polyline points="22,6 12,13 2,6" stroke="#9CA3AF" strokeWidth="2"/></svg>
              <span className="text-gray-400 text-sm">mario.rossi@elettrotech.it</span>
            </div>
          </div>

          <div className="mb-6">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Password</div>
            <div className="border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between bg-gray-50">
              <div className="flex items-center gap-2">
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="#9CA3AF" strokeWidth="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#9CA3AF" strokeWidth="2"/></svg>
                <span className="text-gray-400 text-sm">••••••••</span>
              </div>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#9CA3AF" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="#9CA3AF" strokeWidth="2"/></svg>
            </div>
          </div>

          <button className="w-full py-3.5 rounded-xl text-white font-bold text-sm tracking-wide" style={{ background: "linear-gradient(135deg, #1e3a5f, #2d5f8a)" }}>
            Accedi
          </button>

          <div className="mt-4 text-center text-xs text-gray-400">
            Problemi di accesso? Contatta l'amministratore
          </div>
        </div>

        {/* Footer note */}
        <div className="mt-5 text-center text-xs text-gray-400 px-4">
          🔒 Accesso riservato ai tecnici autorizzati da ELETTROTECH
        </div>
      </div>

      {/* Home indicator */}
      <div className="flex justify-center pb-2 pt-3">
        <div className="w-28 h-1 bg-gray-300 rounded-full"></div>
      </div>
    </div>
  );
}
