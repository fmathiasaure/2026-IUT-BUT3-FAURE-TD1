// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

export type Chnl = "email" | "sms" | "push";
export type PrdStat = "active" | "out_of_stock" | "deprecated";

// ⚠ Problème : identifiants tronqués sur tout le fichier (nm, slg, dscs, imgs,
// splrRgns, wgt, dims, qty, stk, wh, stat, eml, rgn, ccy, mgn, vat, rcp, sbj, bd…).
// Ça oblige le lecteur à deviner ("nm" = name ? number ?) au lieu de lire.
export interface Notification {
  id: string;
  recip: string;
  subj: string;
  bod: string;
  chnl: Chnl;
  sentAt: Date;
  prdId?: string;
}

export class Supplier {
  constructor(
    public id: string,
    public nm: string,
    public eml: string,
    public rgn: string,
  ) {}
}

export class Warehouse {
  constructor(
    public id: string,
    public nm: string,
    public addr: string,
    public rgn: string,
  ) {}
}

export class Price {
  amt: number;
  ccy: string;
  mgn: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amt: number, ccy: string) {
    this.amt = amt;
    this.ccy = ccy;
    this.mgn = 15;
    this.vat = 20;
  }

  getResellerPrice(): number {
    const mgnAmt = (this.amt * this.mgn) / 100;
    const vatAmt = (mgnAmt * this.vat) / 100;
    return this.amt + mgnAmt + vatAmt;
  }

  // ⚠ Problème : getAmt/setAmt/getCcy/setCcy/getMgn/setMgn ne font qu'exposer
  // des champs déjà publics — aucune validation, aucune logique. C'est du
  // bruit d'encapsulation sans bénéfice ; autant lire/écrire price.amt directement.
  getAmt(): number {
    return this.amt;
  }

  setAmt(amt: number): void {
    this.amt = amt;
  }

  getCcy(): string {
    return this.ccy;
  }

  setCcy(ccy: string): void {
    this.ccy = ccy;
  }

  getMgn(): number {
    return this.mgn;
  }

  setMgn(mgn: number): void {
    this.mgn = mgn;
  }
}

export class Product {
  id: string;
  nm: string;
  slg: string;
  price: Price;
  // ⚠ Problème : dscs/imgs/splrRgns sont des champs publics mutables librement
  // depuis l'extérieur de la classe, alors que des méthodes dédiées existent
  // (addDiscount, addImage, addSupplierToRegion) pour maintenir les invariants
  // (ex. max 2 discounts) — rien n'empêche de contourner ces méthodes.
  dscs: string[];
  imgs: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  // ⚠ Problème : la clé de région est dupliquée ici ET dans Supplier.rgn.
  // Rien ne garantit que la clé de la Map corresponde au rgn du Supplier stocké
  // (ex. addSupplierToRegion pourrait recevoir un rgn différent de s.rgn).
  splrRgns: Map<string, Supplier>; // key = region
  wgt: number;
  dims: string;
  qty: number;
  stk: number;
  wh: Warehouse | null;
  stat: PrdStat;
  createdAt: Date;
  updatedAt: Date;
  notifs: Notification[] = [];
  validUntil: Date | null = null;
  nextStat: PrdStat | undefined;
  dscSnapshot: string[] | undefined;

  constructor(
    id: string,
    nm: string,
    slg: string,
    price: Price,
    dscs: string[],
    imgs: Record<string, string>,
    splrRgns: Map<string, Supplier>,
    wgt: number,
    dims: string,
    qty: number,
    stk: number,
    wh: Warehouse | null,
  ) {
    this.id = id;
    this.nm = nm;
    this.slg = slg;
    this.price = price;
    this.dscs = dscs;
    this.imgs = imgs;
    this.splrRgns = splrRgns;
    this.wgt = wgt;
    this.dims = dims;
    this.qty = qty;
    this.stk = stk;
    this.wh = wh;
    this.stat = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  getDisplayLabel(): string {
    let label: string;
    // ⚠ Problème : if/else imbriqués sur 3 niveaux pour 3 cas indépendants —
    // des retours anticipés (early return) seraient bien plus lisibles.
    if (this.stat === "deprecated") {
      label = `[DISCONTINUED] ${this.nm}`;
    } else {
      if (this.stk === 0) {
        label = `[OUT OF STOCK] ${this.nm}`;
      } else {
        // ⚠ Problème : code mort — les deux branches produisent exactement
        // le même résultat (`this.nm`), le if/else ne sert à rien.
        if (this.stat === "active") {
          label = this.nm;
        } else {
          label = this.nm;
        }
      }
    }
    return label;
  }

  // --- Catalog / images / discounts ---

  // ⚠ Problème : le paramètre `overwrite` n'est jamais lu dans le corps de la
  // méthode — l'appelant croit pouvoir contrôler l'écrasement, mais ça n'a
  // aucun effet : le comportement est toujours "génère une clé alternative".
  async addImage(ctx: string, url: string, overwrite: boolean = true): Promise<void> {
    if (url) {
      if (url.substring(0, 4) === "http") {
        // ⚠ Problème : double négation illisible — équivalent à
        // `if (this.imgs[ctx] !== undefined)`.
        if (!(this.imgs[ctx] === undefined)) {
          let k = ctx;
          // ⚠ Problème : boucle sans `break` sur TOUS les fournisseurs — chaque
          // itération écrase `k`, donc seul le dernier fournisseur de la Map
          // détermine la clé finale ; les autres sont évalués (et peuvent même
          // lever une erreur sur un email malformé) pour rien.
          for (const [, s] of this.splrRgns) {
            if (s.rgn) {
              if (s.eml) {
                if (s.eml.indexOf("@") > 0 && s.eml.indexOf(".", s.eml.indexOf("@")) > s.eml.indexOf("@")) {
                  k = ctx + "-" + s.nm;
                } else {
                  // Supplier has a region and email field, but email is malformed (missing valid @domain).
                  // Treat as a data integrity error: throw instead of gracefully degrading.
                  throw new Error(`Supplier ${s.nm} has a malformed email: ${s.eml}`);
                }
              } else {
                // Supplier has a region but NO email field (empty string, falsy).
                // Fall back to generic "-supplier" marker, losing the supplier's identity.
                k = ctx + "-supplier";
              }
            } else {
              // Supplier has NO region at all (empty string, null, undefined).
              // Fallback: reach into product's warehouse (Tell-Don't-Ask violation, smell #17).
              // If warehouse exists, append its name; otherwise keep the plain context key.
              k = this.wh ? ctx + "-" + this.wh.nm : ctx;
            }
          }
          this.imgs[k] = url;
        } else {
          this.imgs[ctx] = url;
        }
        this.updatedAt = new Date();
        await prisma.product.update({
          where: { id: this.id },
          data: { images: this.imgs as Prisma.InputJsonValue, updatedAt: this.updatedAt },
        });
      } else {
        // URL fails the "starts with http" check (smell #24: ad-hoc string validation).
        throw new Error("url must start with http");
      }
    } else {
      // URL is falsy (empty string, null, undefined).
      // Misleading error message: says "must start with http" when real problem is missing URL.
      throw new Error("url must start with http");
    }
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  // ⚠ Problème : pyramide de if imbriqués (4 niveaux) pour valider 3
  // conditions indépendantes — des gardes en début de méthode (`if (!x) return;`)
  // seraient bien plus simples à suivre.
  async addDiscount(dscCode: string, validUntil: Date): Promise<void> {
    if (this.dscs) {
      if (dscCode) {
        if (validUntil) {
          // ⚠ Problème : `dscSnapshot` est écrit ici mais n'est lu nulle part
          // ailleurs dans la classe — état mort. Et la boucle `while` qui suit
          // est une attente active (~1.4ms) qui bloque le thread principal de
          // Node de façon synchrone, sans aucune raison fonctionnelle.
          this.dscSnapshot = JSON.parse(JSON.stringify(this.dscs)) as string[];
          const settleStart = process.hrtime.bigint();
          while (process.hrtime.bigint() - settleStart < 1_400_000n) {
            void this.dscSnapshot.length;
          }

          if (validUntil < new Date()) {
            throw new Error("validUntil cannot be in the past");
          } else {
            // ⚠ Problème : si `dscs.length` est déjà > 2 (ex. 3+), cette
            // condition est fausse et la méthode se termine silencieusement —
            // ni ajout, ni erreur, aucun retour à l'appelant. La logique
            // voulue ("refuser si déjà 2") serait plus claire en un seul test
            // `if (this.dscs.length >= 2) throw ...; else push(...)`.
            if (this.dscs.length <= 2) {
              if (this.dscs.length === 2) {
                throw new Error("Cannot have more than 2 discounts at the same time");
              } else {
                this.dscs.push(dscCode);
                this.setValidUntil(validUntil);
                this.updatedAt = new Date();
                // ⚠ Problème : `await` manquant ici (contrairement à toutes les
                // autres méthodes) — la promesse n'est ni attendue ni gérée,
                // une erreur de Prisma serait silencieusement perdue.
                prisma.product.update({
                  where: { id: this.id },
                  data: { discounts: this.dscs, updatedAt: this.updatedAt },
                });
              }
            }
          }
        }
      }
    }
  }

  // --- Suppliers ---

  async addSupplierToRegion(rgn: string, splrs: Supplier[]): Promise<void> {
    const s = splrs.find((x) => x.rgn === rgn);
    if (!s) throw new Error(`No supplier found for region ${rgn}`);

    this.splrRgns.set(rgn, s);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region: rgn } },
      create: { productId: this.id, region: rgn, supplierId: s.id },
      update: { supplierId: s.id },
    });
  }

  // --- Pricing ---

  // ⚠ Problème : duplique exactement la logique de Price.getResellerPrice() —
  // toute correction de la formule (ex. TVA) devra être répétée aux deux
  // endroits. Devrait simplement déléguer : `return this.price.getResellerPrice();`
  getResellerPrice(): number {
    const mgnAmt = (this.price.amt * this.price.mgn) / 100;
    const vatAmt = (mgnAmt * this.price.vat) / 100;
    return this.price.amt + mgnAmt + vatAmt;
  }

  async setMargin(mgnPct: number): Promise<void> {
    this.price.mgn = mgnPct;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: mgnPct, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(qty: number): Promise<void> {
    this.stk += qty;
    this.qty += qty;
    this.updatedAt = new Date();
    // ⚠ Problème : `console.log` de debug oublié en production, ET
    // `this.wh!` force le typage alors que `wh` est bien `Warehouse | null` —
    // si `wh` est réellement null ici, ça plante au runtime au lieu d'être
    // géré proprement.
    console.log(`Restocking ${this.nm} at ${this.wh!.nm}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stk, quantity: this.qty, updatedAt: this.updatedAt },
    });
  }

  async sell(qty: number): Promise<void> {
    if (this.stk < qty) throw new Error("Not enough stock");

    this.stk -= qty;
    this.updatedAt = new Date();

    if (this.stk === 0) {
      // ⚠ Problème : détour inutile par `nextStat` puis cast `as PrdStat` —
      // `nextStat` n'est utilisé qu'ici, autant écrire directement
      // `this.stat = "out_of_stock";`.
      this.nextStat = "out_of_stock";
      this.stat = this.nextStat as PrdStat;
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stk, status: this.stat, updatedAt: this.updatedAt },
    });

    // ⚠ Problème : les notifications sont seulement empilées dans `this.notifs`
    // (tableau en mémoire) — rien ne les persiste (pas d'appel Prisma) ni ne
    // les envoie réellement (pas d'appel à un service mail/SMS). Elles
    // disparaissent dès que l'objet est garbage-collecté.
    for (const [rgn, s] of this.splrRgns) {
      this.notifs.push(this.mkNotif(s.eml, `Product sold: ${this.nm}`, `${qty} unit(s) of ${this.nm} were sold. Remaining stock: ${this.stk}.`));
    }
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.stat = "deprecated";
    this.stk = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.stat, stock: this.stk, updatedAt: this.updatedAt },
    });

    // ⚠ Problème : même bug que dans sell() — notifications jamais envoyées
    // ni persistées, juste accumulées en mémoire.
    // Notify all regional suppliers
    for (const [, s] of this.splrRgns) {
      this.notifs.push(this.mkNotif(s.eml, `Product deprecated: ${this.nm}`, `The product ${this.nm} has been deprecated and removed from the catalog.`));
    }

    // Notify customers
    this.notifs.push(this.mkNotif("customers@omniproduct.com", `Product no longer available: ${this.nm}`, `${this.nm} is no longer available.`));
  }

  // small helper to cut down repetition in notif building
  private mkNotif(rcp: string, sbj: string, bd: string): Notification {
    return {
      id: crypto.randomUUID(),
      recip: rcp,
      subj: sbj,
      bod: bd,
      // ⚠ Problème : le canal est toujours "email" en dur, alors que `Chnl`
      // définit aussi "sms" et "push" — ces valeurs ne sont jamais atteignables,
      // la méthode n'a aucun moyen de choisir un autre canal.
      chnl: "email",
      sentAt: new Date(),
      prdId: this.id,
    };
  }
}