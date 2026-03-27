import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/refactor');
const files = [];

const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(filePath);
            continue;
        }

        if (filePath.endsWith('.ts')) {
            files.push(filePath);
        }
    }
};

walk(root);

const importPattern = /from\s+['"](\.[^'"]+)['"]/g;
const missing = [];

for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    let matched;
    while ((matched = importPattern.exec(content)) !== null) {
        const specifier = matched[1];
        const base = path.resolve(path.dirname(filePath), specifier);
        const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')];
        if (!candidates.some((candidate) => fs.existsSync(candidate))) {
            missing.push(`${path.relative(process.cwd(), filePath)} -> ${specifier}`);
        }
    }
}

if (missing.length > 0) {
    console.error('发现失效相对导入:');
    for (const item of missing) {
        console.error(`- ${item}`);
    }
    process.exit(1);
}

console.log(`导入检查通过，共扫描 ${files.length} 个文件`);
