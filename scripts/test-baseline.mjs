import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const checks = [];
const check = (name, condition, detail = "") => {
  checks.push({ name, condition, detail });
};

const appLayout = read("src/layouts/AppLayout.tsx");
const documentsPage = read("src/pages/Documents.tsx");
const accessCenter = read("src/pages/AccessCenter.tsx");
const globalsCss = read("src/styles/globals.css");

const mobileNavBlock =
  appLayout.match(/const mobileNavItems = \[[\s\S]*?\n\s*\];/)?.[0] || "";

check(
  "Mobile nav contains Access route",
  mobileNavBlock.includes(
    '{ path: "/access", label: "Access", icon: FiUnlock }'
  )
);
check(
  "Mobile nav contains Passes route",
  mobileNavBlock.includes('{ path: "/nfts", label: "Passes", icon: FiKey }')
);
check(
  "Mobile nav excludes Profile route",
  !mobileNavBlock.includes(
    '{ path: "/profile", label: "Profile", icon: FiUser }'
  )
);

check(
  "Documents imports keyStoreService",
  documentsPage.includes(
    'import { keyStoreService } from "../services/keyStore.service";'
  )
);
check(
  "AccessCenter imports keyStoreService",
  accessCenter.includes(
    'import { keyStoreService } from "../services/keyStore.service";'
  )
);
check(
  "Documents does not read doc keys from localStorage directly",
  !/localStorage\.getItem\([^)]*spoovault-doc-key/.test(documentsPage)
);
check(
  "AccessCenter does not read doc keys from localStorage directly",
  !/localStorage\.getItem\([^)]*spoovault-doc-key/.test(accessCenter)
);

check(
  "Global button hover-lift is scoped to .app-btn",
  globalsCss.includes(".app-btn:hover:not(:disabled)")
);
check(
  "No global button:hover lift selector remains",
  !globalsCss.includes("button:hover:not(:disabled)")
);
check(
  "No role button hover selector remains",
  !globalsCss.includes('[role="button"]:hover')
);

const failed = checks.filter((item) => !item.condition);
checks.forEach((item) => {
  if (item.condition) {
    console.log(`PASS: ${item.name}`);
  } else {
    console.error(
      `FAIL: ${item.name}${item.detail ? ` -> ${item.detail}` : ""}`
    );
  }
});

if (failed.length > 0) {
  console.error(`FAIL: Baseline check failed (${failed.length} issues).`);
  process.exit(1);
}

console.log("PASS: Baseline check complete");
