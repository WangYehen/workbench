import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { IconNotebook, IconBrain } from "@tabler/icons-react";
import { api, todayStr } from "../api.js";
import DateNav from "../components/DateNav.jsx";

export default function ReviewPage() {
  const [date, setDate] = useState(todayStr());
  const [form, setForm] = useState({ did: "", learned: "", mistake: "", mood: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get(`/review/${date}`).then((d) => {
      if (d.review) setForm({ did: d.review.did || "", learned: d.review.learned || "", mistake: d.review.mistake || "", mood: d.review.mood || "" });
    }).catch(() => {});
  }, [date]);

  async function save() {
    await api.put(`/review/${date}`, form);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div>
      <PageHeader
        eyebrow="REVIEW / RETRO"
        title="今日复盘"
        description={`${date} · 记录所做事 / 所学 / 所错，形成成长复盘`}
        actions={
          <div className="row">
            <DateNav date={date} onChange={setDate} />
            {saved && <span className="pill green">已保存</span>}
          </div>
        }
      />
      <div className="grid grid-2">
        <div className="panel">
          <div className="panel__head">
            <div className="panel__title"><span className="work-page-icon"><IconNotebook size={22} stroke={1.75} /></span>做了什么 / 学到什么</div>
          </div>
          <label>今天做了什么事</label>
          <textarea rows={5} value={form.did} onChange={(e) => setForm({ ...form, did: e.target.value })} />
          <label>学到了什么</label>
          <textarea rows={4} value={form.learned} onChange={(e) => setForm({ ...form, learned: e.target.value })} />
        </div>
        <div className="panel">
          <div className="panel__head">
            <div className="panel__title"><span className="work-page-icon"><IconBrain size={22} stroke={1.75} /></span>反思与状态</div>
          </div>
          <label>犯了什么错 / 踩了什么坑</label>
          <textarea rows={5} value={form.mistake} onChange={(e) => setForm({ ...form, mistake: e.target.value })} />
          <label>今日状态</label>
          <div className="row wrap">
            {["好", "平稳", "焦虑", "疲惫", "充实"].map((m) => (
              <button key={m} className={`btn ${form.mood === m ? "primary" : ""}`} onClick={() => setForm({ ...form, mood: m })}>{m}</button>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={save}>保存复盘</button>
        </div>
      </div>
    </div>
  );
}
