import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
const salt = process.env.API_KEY_SALT;
const hash = crypto.createHash("sha256").update(salt + "cnt_ef101f4b316354aaee7148155710c77a00b6b349e00959be").digest("hex");
const prisma = new PrismaClient();
const r = await prisma.apiKey.update({ where: { keyHash: hash }, data: { plan: "starter" } });
console.log("Updated:", r);
await prisma.$disconnect();
