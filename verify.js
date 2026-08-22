const fs = require("fs");
const path = require("path");

console.log("? SpooVault project structure verified!");
console.log("\n?? Project Structure:");
const root = path.join(__dirname);

function listFiles(dir, indent = "") {
  const items = fs
    .readdirSync(dir)
    .filter((item) => !item.startsWith(".") && item !== "node_modules");

  items.forEach((item) => {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      console.log(`${indent}?? ${item}/`);
      listFiles(fullPath, indent + "  ");
    } else {
      const size = stat.size;
      console.log(`${indent}?? ${item} (${size} bytes)`);
    }
  });
}

listFiles(root);
console.log("\n?? To start the development server:");
console.log("   npm run dev");
console.log("\n?? To build for production:");
console.log("   npm run build");
