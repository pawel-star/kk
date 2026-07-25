import { useState, useEffect, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from "recharts";

/* ============================================================
   Licznik kalorii — MVP do testów w przeglądarce
   Dane: window.storage (trwałe, prywatne)
   AI: Anthropic API, model claude-sonnet-4-6
   ============================================================ */

const KEY = "kcal-app-v1";
const todayStr = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

const emptyDay = () => ({ date: todayStr(), entries: [] });

const T = {
  bg: "#F6F7F5", ink: "#1C2321", muted: "#66716B", card: "#FFFFFF",
  line: "#E2E6E1", green: "#2F6B4F", greenSoft: "#E7F0EB",
  red: "#B3402A", redSoft: "#F7E9E5", amber: "#8A6D1F", amberSoft: "#F5EEDB",
};

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/* ---------- storage ---------- */
async function loadState() {
  try {
    const r = await window.storage.get(KEY);
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}
async function saveState(s) {
  try { await window.storage.set(KEY, JSON.stringify(s)); }
  catch (e) { console.error("Błąd zapisu:", e); }
}

/* ---------- AI ---------- */
async function callAI(content) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await res.json();
  console.log("Odpowiedź API (status " + res.status + "):", JSON.stringify(data).slice(0, 800));
  if (data.error) {
    throw new Error(`${data.error.message || data.error.type || "Błąd API"} [HTTP ${res.status}]`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI nie zwróciło poprawnego JSON");
  const parsed = JSON.parse(m[0]);
  if (typeof parsed.kcal !== "number") parsed.kcal = parseInt(parsed.kcal, 10) || 0;
  // Jeśli model rozbił posiłek na składniki, suma składników jest wiarygodniejsza
  // niż jego własna deklaracja łącznej liczby — licz ją po naszej stronie.
  if (Array.isArray(parsed.skladniki) && parsed.skladniki.length > 0) {
    const suma = parsed.skladniki.reduce((a, s) => a + (Number(s.kcal) || 0), 0);
    if (suma > 0) parsed.kcal = Math.round(suma);
  }
  return parsed;
}

/* Zdjęcia z telefonu mają często 4-12 MB i formaty (HEIC), których API nie przyjmuje.
   Przeskalowanie do max 1000 px i konwersja do JPEG rozwiązuje oba problemy.
   Walidujemy wynik, bo w niektórych WebView canvas potrafi zwrócić pusty obraz
   bez zgłoszenia błędu — wtedy do API leciały puste dane. */
async function prepareImage(file, MAX = 1000, QUALITY = 0.8) {
  let width = 0, height = 0, source = null, url = null;
  try {
    if (typeof createImageBitmap === "function") {
      try {
        source = await createImageBitmap(file);
        width = source.width; height = source.height;
      } catch { source = null; }
    }
    if (!source) {
      url = URL.createObjectURL(file);
      source = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("decode"));
        i.src = url;
      });
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    }
    if (!width || !height) throw new Error("decode");
    const scale = Math.min(1, MAX / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
    const base64 = (dataUrl.split(",")[1] || "").trim();
    // pusty/uszkodzony canvas daje "data:," albo kilkuset-bajtowy śmieć
    if (base64.length < 2000) throw new Error("decode");
    return { base64, mediaType: "image/jpeg", kb: Math.round((base64.length * 3) / 4096) };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result.split(",")[1] || "").trim());
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(file);
  });
}

const JSON_RULE = `Odpowiedz WYŁĄCZNIE poprawnym JSON, bez żadnego tekstu przed ani po, w formacie:
{"nazwa":"krótka nazwa po polsku","kcal":liczba_calkowita,"typ":"posiłek" lub "trening","pewnosc":"wysoka" lub "średnia" lub "niska"}`;

const MEAL_RULES = `Zasady szacowania:
1. Rozbij opis na pojedyncze składniki i oszacuj każdy osobno, potem zsumuj.
2. Przeliczaj polskie miary domowe na gramy/mililitry, przyjmuj typowe wartości:
   szklanka = 250 ml, łyżka płatków/kaszy = ok. 10 g, łyżka cukru/miodu = ok. 20 g,
   łyżka oleju/masła = ok. 12 g, łyżeczka = 1/3 łyżki, kromka chleba = ok. 35 g,
   garść orzechów = ok. 30 g, plaster sera/wędliny = ok. 20 g, jajko M = ok. 55 g.
3. Jeśli użytkownik nie podał ilości, przyjmij typową polską porcję i obniż pewność do "średnia".
4. Jeśli nie znasz produktu, przyjmij najbliższy odpowiednik i pewność "niska". Nigdy nie odmawiaj szacunku.
5. Zawsze podaj konkretną liczbę kcal większą od zera, chyba że wpis ewidentnie nie jest jedzeniem.

Odpowiedz WYŁĄCZNIE poprawnym JSON, bez tekstu przed ani po, w formacie:
{"nazwa":"krótka nazwa całego posiłku po polsku","skladniki":[{"nazwa":"składnik","ilosc":"np. 250 ml","kcal":liczba}],"kcal":suma_liczba_calkowita,"typ":"posiłek","pewnosc":"wysoka" lub "średnia" lub "niska"}`;

function mealTextPrompt(text) {
  return [{ type: "text", text: `Oszacuj kaloryczność posiłku opisanego przez użytkownika: "${text}".\n\n${MEAL_RULES}` }];
}
function mealPhotoPrompt(base64, mediaType, note) {
  return [
    { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
    { type: "text", text: `Rozpoznaj, co jest na zdjęciu posiłku${note ? ` (podpowiedź użytkownika: "${note}")` : ""} i oszacuj kaloryczność. Oceń wielkość porcji po proporcjach na zdjęciu (talerz ma zwykle 24-26 cm średnicy).\n\n${MEAL_RULES}` },
  ];
}
function trainingPrompt(text, profile) {
  return [{ type: "text", text: `Oszacuj kalorie spalone podczas aktywności: "${text}". Profil: płeć ${profile.plec}, waga ${profile.waga} kg, wzrost ${profile.wzrost} cm. ${JSON_RULE} (typ: "trening")` }];
}

/* ---------- pomocnicze ---------- */
function bmi(waga, wzrost) {
  const h = wzrost / 100;
  return waga && wzrost ? waga / (h * h) : 0;
}
function bmiLabel(v) {
  if (v < 18.5) return "niedowaga";
  if (v < 25) return "norma";
  if (v < 30) return "nadwaga";
  return "otyłość";
}
function normRange(wzrost) {
  const h = wzrost / 100;
  return [Math.round(18.5 * h * h), Math.round(24.9 * h * h)];
}
function suggestLimit(p) {
  const { plec, waga, wzrost, wiek, aktywnosc, wagaDocelowa } = p;
  if (!waga || !wzrost || !wiek) return null;
  const bmr = 10 * waga + 6.25 * wzrost - 5 * wiek + (plec === "mężczyzna" ? 5 : -161);
  const tdee = bmr * (aktywnosc || 1.2);
  const deficyt = wagaDocelowa && wagaDocelowa < waga ? 400 : 0;
  return Math.round((tdee - deficyt) / 50) * 50;
}
function sums(entries) {
  const zjedzone = entries.filter((e) => e.typ === "posiłek").reduce((a, e) => a + e.kcal, 0);
  const spalone = entries.filter((e) => e.typ === "trening").reduce((a, e) => a + e.kcal, 0);
  return { zjedzone, spalone, netto: zjedzone - spalone };
}
/* wpis ręczny: tekst kończy się liczbą (opcjonalnie "kcal") */
function parseManual(text) {
  const m = text.trim().match(/^(.*?)[\s,]*(\d+)\s*(kcal)?$/i);
  if (!m) return null;
  const name = m[1].trim();
  return { nazwa: name || "Wpis", kcal: parseInt(m[2], 10), pewnosc: "wysoka" };
}

/* ---------- UI: drobne ---------- */
const btn = (primary) => ({
  padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600,
  border: primary ? "none" : `1px solid ${T.line}`,
  background: primary ? T.green : T.card, color: primary ? "#fff" : T.ink,
});
const inputStyle = {
  width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.line}`,
  fontSize: 15, background: "#fff", color: T.ink, boxSizing: "border-box",
};
function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 13, color: T.muted, marginBottom: 5 }}>{label}</div>
      {children}
    </label>
  );
}
function Card({ children, style }) {
  return <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: 18, ...style }}>{children}</div>;
}

/* ---------- Paragon bilansu ---------- */
function Bilans({ day, limit, lastEntry }) {
  const { zjedzone, spalone, netto } = sums(day.entries);
  const zostalo = limit - netto;
  const over = zostalo < 0;
  const row = (l, r, strong) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontWeight: strong ? 700 : 400 }}>
      <span>{l}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{r}</span>
    </div>
  );
  return (
    <Card style={{ fontFamily: mono, fontSize: 14, background: "#FCFDFB" }}>
      {lastEntry && (
        <div style={{ paddingBottom: 8, marginBottom: 8, borderBottom: `1px dashed ${T.line}` }}>
          🟢 Wpis: {lastEntry.nazwa} ({lastEntry.typ === "trening" ? "−" : "+"}{lastEntry.kcal} kcal)
        </div>
      )}
      <div style={{ fontWeight: 700, marginBottom: 6 }}>📊 BIEŻĄCY BILANS (NETTO)</div>
      {row("Zjedzone", `${zjedzone} kcal`)}
      {row("Spalone (ćwiczenia)", `${spalone} kcal`)}
      {row("Wynik netto", `${netto} / ${limit} kcal`)}
      <div style={{ borderTop: `1px dashed ${T.line}`, marginTop: 6, paddingTop: 6 }}>
        {over
          ? <div style={{ color: T.red, fontWeight: 700 }}>PRZEKROCZONO LIMIT o {Math.abs(zostalo)} kcal</div>
          : row("POZOSTAŁO DO LIMITU", `${zostalo} kcal`, true)}
      </div>
    </Card>
  );
}

/* ---------- Onboarding / Ustawienia (wspólny formularz) ---------- */
function ProfileForm({ initial, onSave, mode }) {
  const [p, setP] = useState(initial || {
    plec: "mężczyzna", wzrost: "", waga: "", wiek: "", aktywnosc: 1.2,
    wagaDocelowa: "", pomiary: { biodra: "", brzuch: "", biceps: "" }, limit: "",
  });
  const [limitTouched, setLimitTouched] = useState(mode === "edit");
  const num = (v) => (v === "" ? "" : Number(v));
  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));
  const setPom = (k, v) => setP((s) => ({ ...s, pomiary: { ...s.pomiary, [k]: v } }));

  const b = bmi(num(p.waga), num(p.wzrost));
  const [lo, hi] = p.wzrost ? normRange(num(p.wzrost)) : [0, 0];
  const sug = suggestLimit({ ...p, waga: num(p.waga), wzrost: num(p.wzrost), wiek: num(p.wiek), wagaDocelowa: num(p.wagaDocelowa) });

  useEffect(() => {
    if (!limitTouched && sug) setP((s) => ({ ...s, limit: sug }));
  }, [sug, limitTouched]);

  const valid = p.wzrost && p.waga && p.wiek && p.limit;

  return (
    <div>
      <Field label="Płeć">
        <div style={{ display: "flex", gap: 8 }}>
          {["mężczyzna", "kobieta"].map((g) => (
            <button key={g} onClick={() => set("plec", g)}
              style={{ ...btn(p.plec === g), flex: 1 }}>{g}</button>
          ))}
        </div>
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Field label="Wzrost (cm)"><input type="number" style={inputStyle} value={p.wzrost} onChange={(e) => set("wzrost", e.target.value)} /></Field>
        <Field label="Waga (kg)"><input type="number" style={inputStyle} value={p.waga} onChange={(e) => set("waga", e.target.value)} /></Field>
        <Field label="Wiek"><input type="number" style={inputStyle} value={p.wiek} onChange={(e) => set("wiek", e.target.value)} /></Field>
      </div>

      {b > 0 && (
        <Card style={{ marginBottom: 14, background: T.greenSoft, border: "none" }}>
          <div style={{ fontSize: 14 }}>
            Twoje BMI: <b>{b.toFixed(1)}</b> ({bmiLabel(b)}).<br />
            Dla Twojego wzrostu waga w normie to <b>{lo}–{hi} kg</b>.
          </div>
        </Card>
      )}

      <Field label="Waga docelowa (kg) — możesz przyjąć sugestię albo wpisać własną">
        <input type="number" style={inputStyle} value={p.wagaDocelowa} onChange={(e) => set("wagaDocelowa", e.target.value)} />
      </Field>

      <Field label="Poziom aktywności (bez treningów — te logujesz w aplikacji)">
        <select style={inputStyle} value={p.aktywnosc} onChange={(e) => set("aktywnosc", Number(e.target.value))}>
          <option value={1.2}>siedzący — loguję treningi w aplikacji (zalecane)</option>
          <option value={1.375}>lekki (1–3 treningi/tydz. wliczone w limit)</option>
          <option value={1.55}>umiarkowany (3–5 treningów/tydz. wliczone w limit)</option>
          <option value={1.725}>wysoki (6–7 treningów/tydz. wliczone w limit)</option>
        </select>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 5 }}>
          Jeśli wybierzesz poziom wyższy niż „siedzący", treningi siedzą już w limicie.
          Logując je dodatkowo jako wpisy, policzysz je podwójnie i zawyżysz pulę kalorii.
        </div>
      </Field>

      {mode !== "edit" && (
        <>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 5 }}>Pomiary startowe (cm)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Field label="Biodra"><input type="number" style={inputStyle} value={p.pomiary.biodra} onChange={(e) => setPom("biodra", e.target.value)} /></Field>
            <Field label="Brzuch (pas)"><input type="number" style={inputStyle} value={p.pomiary.brzuch} onChange={(e) => setPom("brzuch", e.target.value)} /></Field>
            <Field label="Biceps"><input type="number" style={inputStyle} value={p.pomiary.biceps} onChange={(e) => setPom("biceps", e.target.value)} /></Field>
          </div>
        </>
      )}

      <Field label={`Dzienny limit kaloryczny${sug ? ` (propozycja: ${sug} kcal — Mifflin-St Jeor${num(p.wagaDocelowa) < num(p.waga) ? " z deficytem ~400 kcal" : ""})` : ""}`}>
        <input type="number" style={inputStyle} value={p.limit}
          onChange={(e) => { setLimitTouched(true); set("limit", e.target.value); }} />
      </Field>
      {mode === "edit" && (
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>
          Zmiana limitu działa od bieżącego dnia. Historia zostaje bez zmian.
        </div>
      )}

      <button disabled={!valid} style={{ ...btn(true), width: "100%", opacity: valid ? 1 : 0.5 }}
        onClick={() => onSave({
          ...p, wzrost: num(p.wzrost), waga: num(p.waga), wiek: num(p.wiek),
          wagaDocelowa: num(p.wagaDocelowa), limit: num(p.limit),
        })}>
        {mode === "edit" ? "Zapisz zmiany" : "Zaczynamy"}
      </button>
    </div>
  );
}

/* ---------- Dzisiaj ---------- */
function Today({ state, update }) {
  const [text, setText] = useState("");
  const [typ, setTyp] = useState("posiłek");
  const [pending, setPending] = useState(null); // {nazwa,kcal,typ,pewnosc}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [lastId, setLastId] = useState(null);
  const fileRef = useRef(null);

  const day = state.currentDay;
  const limit = state.profile.limit;
  const lastEntry = day.entries.find((e) => e.id === lastId) || null;

  async function estimate() {
    setErr("");
    if (!text.trim()) return;
    const manual = parseManual(text);
    if (manual) { setPending({ ...manual, typ }); setText(""); return; }
    setBusy(true);
    try {
      const content = typ === "trening"
        ? trainingPrompt(text, state.profile)
        : mealTextPrompt(text);
      const r = await callAI(content);
      setPending({ nazwa: r.nazwa, kcal: r.kcal, typ, pewnosc: r.pewnosc || "średnia", skladniki: r.skladniki });
      setText("");
    } catch (e) {
      setErr("Nie udało się oszacować kalorii. Spróbuj ponownie albo wpisz liczbę ręcznie (np. \"obiad 650\").");
    } finally { setBusy(false); }
  }

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(""); setBusy(true);
    let sizeInfo = "";
    try {
      let img;
      try {
        img = await prepareImage(file);
        sizeInfo = ` (wysłano ${img.kb} kB JPEG)`;
      } catch {
        // przeglądarka nie zdekodowała formatu (np. HEIC poza Safari) — próba wysyłki oryginału
        if (file.size > 4.5 * 1024 * 1024) {
          throw new Error(`Nie mogę skompresować tego zdjęcia, a oryginał ma ${(file.size / 1024 / 1024).toFixed(1)} MB — za dużo dla API`);
        }
        img = { base64: await fileToBase64(file), mediaType: file.type || "image/jpeg" };
        sizeInfo = ` (wysłano oryginał ${Math.round(file.size / 1024)} kB, ${img.mediaType})`;
      }
      const r = await (async () => {
        try {
          return await callAI(mealPhotoPrompt(img.base64, img.mediaType, text.trim()));
        } catch (firstErr) {
          // druga próba: mocniejsza kompresja — część błędów bierze się z rozmiaru payloadu
          try {
            const small = await prepareImage(file, 600, 0.6);
            sizeInfo = ` (2. próba: ${small.kb} kB JPEG)`;
            return await callAI(mealPhotoPrompt(small.base64, small.mediaType, text.trim()));
          } catch {
            throw firstErr;
          }
        }
      })();
      setPending({ nazwa: r.nazwa, kcal: r.kcal, typ: "posiłek", pewnosc: r.pewnosc || "średnia", skladniki: r.skladniki });
      setText("");
    } catch (ex) {
      const msg = String(ex?.message || "nieznany błąd");
      if (/heic|media_type/i.test(msg)) {
        setErr(`Format zdjęcia nie przeszedł${sizeInfo}. Zmień w telefonie format aparatu na „najbardziej zgodny" (JPEG) albo wgraj zrzut ekranu zdjęcia.`);
      } else if (/too large|exceeds|payload|413|za dużo/i.test(msg)) {
        setErr(`${msg}. Spróbuj mniejszego zdjęcia albo opisz posiłek tekstem.`);
      } else {
        setErr(`Nie udało się przetworzyć zdjęcia: ${msg}${sizeInfo}. Opisz posiłek tekstem albo wpisz kcal ręcznie.`);
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function savePending() {
    const entry = { id: Date.now(), ...pending, kcal: Number(pending.kcal) || 0 };
    update((s) => ({ ...s, currentDay: { ...s.currentDay, entries: [...s.currentDay.entries, entry] } }));
    setLastId(entry.id);
    setPending(null);
  }
  function removeEntry(id) {
    update((s) => ({ ...s, currentDay: { ...s.currentDay, entries: s.currentDay.entries.filter((e) => e.id !== id) } }));
    if (lastId === id) setLastId(null);
  }
  function saveEdit(id) {
    const v = Number(editVal);
    if (!Number.isFinite(v)) return;
    update((s) => ({
      ...s,
      currentDay: { ...s.currentDay, entries: s.currentDay.entries.map((e) => (e.id === id ? { ...e, kcal: v } : e)) },
    }));
    setEditId(null);
  }
  function newDay(saveToHistory) {
    update((s) => {
      const d = s.currentDay;
      const hist = saveToHistory && d.entries.length > 0
        ? [...s.history, { date: d.date, ...sums(d.entries), limit: s.profile.limit }]
        : s.history;
      return { ...s, history: hist, currentDay: emptyDay() };
    });
    setLastId(null); setPending(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Bilans day={day} limit={limit} lastEntry={lastEntry} />

      <Card>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {["posiłek", "trening"].map((t) => (
            <button key={t} onClick={() => setTyp(t)} style={{ ...btn(typ === t), flex: 1 }}>
              {t === "posiłek" ? "🍽 Posiłek (+kcal)" : "🏃 Trening (−kcal)"}
            </button>
          ))}
        </div>
        <textarea
          style={{ ...inputStyle, minHeight: 60, resize: "vertical", fontFamily: "inherit" }}
          placeholder={typ === "posiłek"
            ? 'np. "4 gofry z bitą śmietaną i truskawkami" albo "napój białkowy 150"'
            : 'np. "rower 45 min" albo "trening 700"'}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); estimate(); } }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button style={{ ...btn(true), flex: 1, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={estimate}>
            {busy ? "Szacuję…" : "Dodaj wpis"}
          </button>
          {typ === "posiłek" && (
            <button style={btn(false)} disabled={busy} onClick={() => fileRef.current?.click()}>📷 Zdjęcie</button>
          )}
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPhoto} />
        </div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>
          Wskazówka: wpis zakończony liczbą (np. „obiad 650”) zapisuje się bez pytania AI.
        </div>
        {err && <div style={{ color: T.red, fontSize: 13, marginTop: 8 }}>{err}</div>}
      </Card>

      {pending && (
        <Card style={{ border: `1px solid ${T.green}` }}>
          <div style={{ fontSize: 13, color: T.muted, marginBottom: 6 }}>
            Szacunek do akceptacji {pending.pewnosc === "niska" && <span style={{ color: T.amber }}>(niska pewność — to zgrubny szacunek)</span>}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...inputStyle, flex: 2, minWidth: 140 }} value={pending.nazwa}
              onChange={(e) => setPending({ ...pending, nazwa: e.target.value })} />
            <input type="number" style={{ ...inputStyle, width: 100 }} value={pending.kcal}
              onChange={(e) => setPending({ ...pending, kcal: e.target.value })} />
            <span style={{ fontSize: 13, color: T.muted }}>kcal ({pending.typ})</span>
          </div>
          {Array.isArray(pending.skladniki) && pending.skladniki.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 13, fontFamily: mono, color: T.muted }}>
              {pending.skladniki.map((s, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span>{s.nazwa}{s.ilosc ? ` (${s.ilosc})` : ""}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{s.kcal} kcal</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={{ ...btn(true), flex: 1 }} onClick={savePending}>Zapisz</button>
            <button style={btn(false)} onClick={() => setPending(null)}>Anuluj</button>
          </div>
        </Card>
      )}

      <Card>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Wpisy — {day.date}</div>
        {day.entries.length === 0 && <div style={{ color: T.muted, fontSize: 14 }}>Brak wpisów. Dodaj pierwszy posiłek albo trening.</div>}
        {day.entries.map((e) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${T.line}` }}>
            <span style={{ flex: 1, fontSize: 14 }}>{e.typ === "trening" ? "🏃" : "🍽"} {e.nazwa}</span>
            {editId === e.id ? (
              <>
                <input type="number" style={{ ...inputStyle, width: 90, padding: "6px 8px" }} value={editVal} onChange={(ev) => setEditVal(ev.target.value)} />
                <button style={{ ...btn(true), padding: "6px 10px" }} onClick={() => saveEdit(e.id)}>OK</button>
              </>
            ) : (
              <>
                <span style={{ fontFamily: mono, fontVariantNumeric: "tabular-nums", color: e.typ === "trening" ? T.green : T.ink }}>
                  {e.typ === "trening" ? "−" : "+"}{e.kcal} kcal
                </span>
                <button style={{ ...btn(false), padding: "5px 9px", fontSize: 12 }} onClick={() => { setEditId(e.id); setEditVal(e.kcal); }}>edytuj</button>
                <button style={{ ...btn(false), padding: "5px 9px", fontSize: 12, color: T.red }} onClick={() => removeEntry(e.id)}>usuń</button>
              </>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button style={{ ...btn(true), flex: 1 }} onClick={() => newDay(true)}>Nowy dzień (zapisz do historii)</button>
          <button style={{ ...btn(false), color: T.red }} onClick={() => { if (confirm("Wyzerować bieżący dzień bez zapisu?")) newDay(false); }}>Reset</button>
        </div>
      </Card>
    </div>
  );
}

/* ---------- Pomiary ---------- */
const METRICS = [
  { k: "waga", label: "Waga (kg)" },
  { k: "biodra", label: "Biodra (cm)" },
  { k: "brzuch", label: "Brzuch (cm)" },
  { k: "biceps", label: "Biceps (cm)" },
];
function Measurements({ state, update }) {
  const [form, setForm] = useState({ waga: "", biodra: "", brzuch: "", biceps: "" });
  const [metric, setMetric] = useState("waga");
  const list = state.measurements;
  const last = list[list.length - 1];
  const first = list[0];

  function add() {
    const m = { date: todayStr() };
    let any = false;
    METRICS.forEach(({ k }) => {
      const v = Number(form[k]);
      if (form[k] !== "" && Number.isFinite(v)) { m[k] = v; any = true; }
    });
    if (!any) return;
    update((s) => ({ ...s, measurements: [...s.measurements, m] }));
    setForm({ waga: "", biodra: "", brzuch: "", biceps: "" });
  }
  const diff = (k) => {
    if (!last) return null;
    const prev = list[list.length - 2];
    const d1 = prev && prev[k] != null && last[k] != null ? last[k] - prev[k] : null;
    const d0 = first && first[k] != null && last[k] != null && first !== last ? last[k] - first[k] : null;
    return { d1, d0 };
  };
  const fmt = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
  const chartData = metric === "bmi"
    ? list.filter((m) => m.waga != null).map((m) => ({ date: m.date.slice(5), v: Number(bmi(m.waga, state.profile.wzrost).toFixed(1)) }))
    : list.filter((m) => m[metric] != null).map((m) => ({ date: m.date.slice(5), v: m[metric] }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Nowy pomiar ({todayStr()})</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {METRICS.map(({ k, label }) => (
            <Field key={k} label={label}>
              <input type="number" style={inputStyle} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <button style={{ ...btn(true), width: "100%" }} onClick={add}>Zapisz pomiar</button>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>Sugerowana częstotliwość: raz w tygodniu.</div>
      </Card>

      {last && (
        <Card style={{ background: T.greenSoft, border: "none" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Ostatni pomiar: {last.date}</div>
          {METRICS.map(({ k, label }) => {
            if (last[k] == null) return null;
            const d = diff(k);
            return (
              <div key={k} style={{ fontSize: 14, padding: "2px 0" }}>
                {label}: <b>{last[k]}</b>
                {d?.d1 != null && ` (${fmt(d.d1)} od poprzedniego)`}
                {d?.d0 != null && `, ${fmt(d.d0)} od startu`}
              </div>
            );
          })}
          {last.waga != null && state.profile.wzrost && (() => {
            const bNow = bmi(last.waga, state.profile.wzrost);
            const firstW = list.find((m) => m.waga != null);
            const bStart = firstW && firstW !== last ? bmi(firstW.waga, state.profile.wzrost) : null;
            return (
              <div style={{ fontSize: 14, padding: "6px 0 2px", marginTop: 4, borderTop: `1px solid rgba(0,0,0,0.08)` }}>
                BMI: <b>{bNow.toFixed(1)}</b> ({bmiLabel(bNow)})
                {bStart != null && `, ${fmt(bNow - bStart)} od startu`}
              </div>
            );
          })()}
        </Card>
      )}

      <Card>
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {[...METRICS, { k: "bmi", label: "BMI" }].map(({ k, label }) => (
            <button key={k} onClick={() => setMetric(k)} style={{ ...btn(metric === k), padding: "6px 10px", fontSize: 13 }}>{label}</button>
          ))}
        </div>
        {chartData.length > 1 ? (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke={T.line} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                <Tooltip />
                <Line type="monotone" dataKey="v" stroke={T.green} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ color: T.muted, fontSize: 14 }}>Wykres pojawi się po drugim pomiarze.</div>
        )}
      </Card>

      {list.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Wszystkie pomiary</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: T.muted, textAlign: "left" }}>
                  <th style={{ padding: 6 }}>Data</th>
                  {METRICS.map((m) => <th key={m.k} style={{ padding: 6 }}>{m.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...list].reverse().map((m, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${T.line}` }}>
                    <td style={{ padding: 6 }}>{m.date}</td>
                    {METRICS.map(({ k }) => <td key={k} style={{ padding: 6, fontFamily: mono }}>{m[k] ?? "—"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------- Historia ---------- */
function History({ state }) {
  const hist = [...state.history].sort((a, b) => (a.date < b.date ? 1 : -1));
  const last7 = hist.slice(0, 7);
  const avg = last7.length ? Math.round(last7.reduce((a, d) => a + d.netto, 0) / last7.length) : null;
  const limit = state.profile.limit;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ background: avg != null && avg > limit ? T.redSoft : T.greenSoft, border: "none" }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Tydzień</div>
        {avg != null ? (
          <div style={{ fontSize: 14 }}>
            Średnie netto z ostatnich {last7.length} dni: <b style={{ fontFamily: mono }}>{avg} kcal</b> przy limicie {limit} kcal
            {" "}({avg <= limit ? `${limit - avg} kcal zapasu` : `${avg - limit} kcal ponad limit`}).
          </div>
        ) : (
          <div style={{ color: T.muted, fontSize: 14 }}>Zamknij pierwszy dzień, a pojawi się tu widok tygodniowy.</div>
        )}
      </Card>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Zamknięte dni</div>
        {hist.length === 0 && <div style={{ color: T.muted, fontSize: 14 }}>Historia jest pusta.</div>}
        {hist.map((d, i) => {
          const ok = d.netto <= d.limit;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
              <span style={{ width: 86 }}>{d.date}</span>
              <span style={{ flex: 1, fontFamily: mono, fontVariantNumeric: "tabular-nums" }}>
                {d.zjedzone} − {d.spalone} = <b>{d.netto}</b> / {d.limit}
              </span>
              <span style={{
                fontSize: 12, fontWeight: 700, padding: "3px 8px", borderRadius: 20,
                background: ok ? T.greenSoft : T.redSoft, color: ok ? T.green : T.red,
              }}>{ok ? "w limicie" : `+${d.netto - d.limit}`}</span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

/* ---------- App ---------- */
export default function App() {
  const [state, setState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("dzisiaj");

  useEffect(() => {
    (async () => {
      let s = await loadState();
      if (s && s.currentDay && s.currentDay.date !== todayStr()) {
        // automatyczne zamknięcie poprzedniego dnia
        const d = s.currentDay;
        const hist = d.entries.length > 0
          ? [...s.history, { date: d.date, ...sums(d.entries), limit: s.profile.limit }]
          : s.history;
        s = { ...s, history: hist, currentDay: emptyDay() };
        await saveState(s);
      }
      setState(s);
      setLoaded(true);
    })();
  }, []);

  function update(fn) {
    setState((prev) => {
      const next = fn(prev);
      saveState(next);
      return next;
    });
  }

  if (!loaded) {
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: T.bg, color: T.muted, fontFamily: "system-ui, sans-serif" }}>Wczytuję dane…</div>;
  }

  const shell = (children) => (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "20px 14px 60px" }}>{children}</div>
    </div>
  );

  if (!state || !state.profile) {
    return shell(
      <>
        <h1 style={{ fontSize: 22, margin: "6px 0 2px" }}>Licznik kalorii</h1>
        <p style={{ color: T.muted, fontSize: 14, marginTop: 0 }}>Kilka pytań na start. Wszystko zmienisz później w ustawieniach.</p>
        <Card>
          <ProfileForm mode="onboarding" onSave={(p) => {
            const pomiaryStart = ["biodra", "brzuch", "biceps"].some((k) => p.pomiary[k] !== "")
              ? [{
                  date: todayStr(), waga: p.waga,
                  ...Object.fromEntries(["biodra", "brzuch", "biceps"].map((k) => [k, p.pomiary[k] === "" ? undefined : Number(p.pomiary[k])])),
                }]
              : [{ date: todayStr(), waga: p.waga }];
            const s = { profile: p, currentDay: emptyDay(), history: [], measurements: pomiaryStart };
            saveState(s); setState(s);
          }} />
        </Card>
      </>
    );
  }

  const tabs = [
    ["dzisiaj", "Dzisiaj"], ["pomiary", "Pomiary"], ["historia", "Historia"], ["ustawienia", "Ustawienia"],
  ];

  return shell(
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Licznik kalorii</h1>
        <span style={{ fontSize: 13, color: T.muted, fontFamily: mono }}>limit {state.profile.limit} kcal</span>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ ...btn(view === k), flex: 1, padding: "8px 4px", fontSize: 13 }}>{l}</button>
        ))}
      </div>
      {view === "dzisiaj" && <Today state={state} update={update} />}
      {view === "pomiary" && <Measurements state={state} update={update} />}
      {view === "historia" && <History state={state} />}
      {view === "ustawienia" && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Edycja profilu</div>
          <ProfileForm mode="edit" initial={{ ...state.profile, pomiary: { biodra: "", brzuch: "", biceps: "" } }}
            onSave={(p) => update((s) => ({ ...s, profile: { ...s.profile, ...p } }))} />
        </Card>
      )}
    </>
  );
}
