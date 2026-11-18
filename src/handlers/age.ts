import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import { FormatDefinition } from "../FormatHandler.ts";
import { Category, SpecialFormats } from "src/Formats.ts";
import type { ConvertContext } from "src/ui/ProgressStore.ts";
import { stripExt } from "src/common/index.ts";
import { filePath } from "src/common/path.ts";
import { uniqueNames } from "src/batch.ts";

export const AGE = new FormatDefinition(
  "age encrypted file",
  "age",
  "age",
  "application/x-age-encryption",
  Category.ARCHIVE,
);

/** What an age file opens into: the original file, whatever it was, under its own name. */
export const AGE_OPENED = new FormatDefinition(
  "Opened age file (the original)",
  "age-opened",
  "bin",
  "application/octet-stream",
  Category.ARCHIVE,
);

/** The ASCII header every age file starts with. */
const MAGIC = "age-encryption.org/v1\n";

/** Whether the passphrase field holds age public keys (age1...) instead of a passphrase. */
export const isRecipientList = (text: string) =>
  text
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((part) => /^age1[0-9a-z]+$/.test(part));

/** Whether the passphrase field holds a secret key (AGE-SECRET-KEY-1...). */
export const isIdentity = (text: string) => /^AGE-SECRET-KEY-(PQ-)?1[0-9A-Z]+$/.test(text.trim());

/**
 * Encrypts files with age (https://age-encryption.org) using typage, the reference TypeScript
 * implementation: with a passphrase (scrypt), or for age public keys. Several files become one
 * zip first, so a vault of notes and documents is one file. The same tool opens it again.
 * Files made here open with `age -d` and with Skyhold's vault, and the other way round.
 */
class ageHandler implements FormatHandler {
  public readonly name = "age";
  public supportedFormats = [
    SpecialFormats.ANY.builder("ANY").lossless().from(),
    AGE.builder("age").lossless().from(),
    AGE.builder("age").lossless().options({ passphrase: true }).to(),
    AGE_OPENED.builder("age-opened").lossless().options({ passphrase: true }).to(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    ctx?: ConvertContext,
  ): Promise<FileData[]> {
    const secret = (ctx?.options.passphrase as string | undefined)?.trim();
    if (!secret) {
      throw new Error("Set a passphrase in Settings first (or age public keys, or a secret key).");
    }
    const { Encrypter, Decrypter } = await import("age-encryption");

    if (inputFormat.internal === "age") {
      if (outputFormat.internal !== "age-opened")
        throw new TypeError("age only opens into the original.");
      const decrypter = new Decrypter();
      if (isIdentity(secret)) decrypter.addIdentity(secret);
      else decrypter.addPassphrase(secret);
      const outputs: FileData[] = [];
      for (const [i, file] of inputFiles.entries()) {
        ctx?.throwIfAborted();
        ctx?.progress(`Opening ${file.name}...`, i / inputFiles.length);
        const head = new TextDecoder().decode(file.bytes.subarray(0, MAGIC.length));
        if (head !== MAGIC) throw new Error(`${file.name} is not an age file (or it is armored).`);
        let bytes: Uint8Array;
        try {
          bytes = await decrypter.decrypt(file.bytes);
        } catch (error) {
          throw new Error(
            `${file.name} did not open: wrong passphrase or key, or a damaged file.`,
            {
              cause: error,
            },
          );
        }
        outputs.push({ name: file.name.replace(/\.age$/i, "") || "decrypted", bytes });
      }
      return outputs;
    }

    if (outputFormat.internal !== "age") throw new TypeError("This tool writes age files.");
    const encrypter = new Encrypter();
    if (isRecipientList(secret)) {
      for (const key of secret.split(/[\s,]+/).filter(Boolean)) encrypter.addRecipient(key);
    } else if (isIdentity(secret)) {
      throw new Error("That is a secret key: use the public key (age1...) to encrypt.");
    } else encrypter.setPassphrase(secret);

    let plain: FileData;
    if (inputFiles.length === 1) {
      plain = inputFiles[0];
    } else {
      ctx?.progress("Packing the files into one vault...", 0);
      const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = await import("@zip.js/zip.js");
      const writer = new ZipWriter(new Uint8ArrayWriter());
      const names = uniqueNames(inputFiles.map((file) => filePath(file)));
      for (const [i, file] of inputFiles.entries()) {
        await writer.add(names[i], new Uint8ArrayReader(file.bytes));
      }
      plain = { name: `${stripExt(inputFiles[0].name)}-vault.zip`, bytes: await writer.close() };
    }
    ctx?.progress(`Encrypting ${plain.name}...`, 0.5);
    return [{ name: `${plain.name}.age`, bytes: await encrypter.encrypt(plain.bytes) }];
  }
}

export default ageHandler;
