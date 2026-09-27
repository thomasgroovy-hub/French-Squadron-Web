import "./tests/helpers/env.js";
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import { renderDiscordMarkdown } from "./src/utils/discord-markdown.js";

const views = path.join(process.cwd(), "src", "views");
const blocks = [
  { id: 1, type: "heading", typeLabel: "Titre", tone: "cyan", icon: "heading", title: "A", content: "", url: "", items: [] },
  { id: 2, type: "text", typeLabel: "Texte", tone: "cyan", icon: "text", title: "", content: "x", url: "", items: [] },
  { id: 3, type: "link", typeLabel: "Lien", tone: "success", icon: "link", title: "B", content: "", url: "https://d.com", items: [] },
  { id: 4, type: "bullets", typeLabel: "Liste", tone: "success", icon: "bullets", title: "", content: "a\nb", url: "", items: ["a","b"] },
  { id: 5, type: "separator", typeLabel: "Séparateur", tone: "neutral", icon: "separator", title: "", content: "", url: "", items: [] },
];
const file = path.join(views, "documentation.ejs");
const html = ejs.render(fs.readFileSync(file, "utf8"), {
  renderDiscordMarkdown, currentPath: "/documentation", blocks, isFormManager: true, error: null, notice: null,
  currentUser: { username: "a", globalName: "A", avatarUrl: null },
}, { filename: file });

const tally = (re) => (html.match(re) || []).length;
console.log("doc-edit forms   :", tally(/<form class="doc-edit"/g));
console.log("insert forms     :", tally(/action="\/documentation\/blocs" method="post" class="doc-insert-form"/g));
console.log("form+typed       :", tally(/<form[^>]*data-typed-form/g));
console.log("selects          :", tally(/<select[^>]*name="block_type"/g));
console.log("--- every <form ...> tag:");
for (const m of html.matchAll(/<form[^>]*>/g)) console.log("   ", m[0].replace(/\s+/g, " ").slice(0, 150));
