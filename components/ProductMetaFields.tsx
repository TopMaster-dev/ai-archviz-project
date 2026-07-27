import React, { useState } from 'react';

/**
 * 見積行の「名前 / メーカー名 / 品番 / 価格 / URL / メモ」共通編集フォーム（260728 クライアント #6）。
 *
 * クライアント要望:「名前/メーカー名/品番/価格/URLを任意で変更できるように」「家具だけでなく建材、巾木、
 * AI追加アイテムの仕様を全て統一してください」。
 *
 * 4セクション（建材 / 巾木 / インテリア / AI追加アイテム）でこの1コンポーネントを共有し、
 * 表示・バリデーション・URLリンクの扱いを揃える。値は「上書き（override）」モデルで、
 * 未入力なら元データ（カタログ/アップロード台帳）の値が使われる＝placeholder に元値を出す。
 *
 * レイアウト方針: 価格は使用頻度が高いので常時表示、それ以外は行ごとの「詳細」トグルの中に置く。
 * 全項目を常時展開すると1行が縦に伸びすぎ、面数の多い案件でパネルが実用に耐えないため。
 */
export interface ProductMetaValues {
  name?: string;
  brand?: string;
  modelNumber?: string;
  /** 建材＝㎡単価 / 巾木＝m単価 / 家具・AI＝商品金額。 */
  unitPrice?: number;
  productUrl?: string;
  memo?: string;
}

export interface ProductMetaFieldsProps {
  /** 現在の上書き値（未設定の項目は undefined）。 */
  values: ProductMetaValues;
  /** 未入力時に薄字で見せる元データ（カタログ/台帳の値）。 */
  placeholders?: ProductMetaValues;
  /** 価格欄の単位表記（例: '円/㎡'・'円/m'・'円'）。 */
  priceUnitLabel: string;
  /** 部分更新を通知する（undefined の項目は変更しない）。 */
  onChange: (patch: ProductMetaValues) => void;
  /** 入力確定時（blur）に呼ぶ。アップロード台帳への書き戻しなど、重い処理はここで。 */
  onCommit?: () => void;
  /** 詳細欄の見出し（既定「詳細」）。 */
  detailLabel?: string;
}

const inputClass =
  'w-full rounded bg-black/40 px-2 py-1 text-[10px] text-white outline-none ring-1 ring-white/10 focus:ring-emerald-400/60 placeholder:text-neutral-600';
const labelClass = 'text-[9px] font-bold text-neutral-400 shrink-0';

/** http(s) だけ開く（既存の見積UIと同じガード）。 */
export function isOpenableUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url.trim());
}

export const ProductMetaFields: React.FC<ProductMetaFieldsProps> = ({
  values,
  placeholders,
  priceUnitLabel,
  onChange,
  onCommit,
  detailLabel = '詳細',
}) => {
  const [open, setOpen] = useState(false);
  // 上書きが1つでも入っていれば、閉じていても分かるように印を出す。
  const hasDetail = !!(values.name || values.brand || values.modelNumber || values.productUrl || values.memo);

  const text = (
    key: keyof ProductMetaValues,
    label: string,
    placeholder: string | undefined,
    type: 'text' | 'url' = 'text'
  ) => (
    <div className="flex items-center gap-1">
      <span className={`${labelClass} w-[52px]`}>{label}</span>
      <input
        type={type}
        value={(values[key] as string | undefined) ?? ''}
        placeholder={placeholder || '未設定'}
        onChange={(e) => onChange({ [key]: e.target.value } as ProductMetaValues)}
        onBlur={onCommit}
        className={inputClass}
      />
    </div>
  );

  return (
    <div className="mt-2 space-y-1.5">
      {/* 価格は常時表示（最も使う項目） */}
      <div className="flex items-center gap-1">
        <span className={`${labelClass} w-[52px]`}>価格</span>
        <input
          inputMode="numeric"
          value={values.unitPrice ?? ''}
          placeholder={placeholders?.unitPrice != null ? String(Math.round(placeholders.unitPrice)) : '未設定'}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange({ unitPrice: raw === '' ? undefined : Math.max(0, Number(raw) || 0) });
          }}
          onBlur={onCommit}
          className={inputClass}
        />
        <span className="text-[9px] font-bold text-neutral-500 shrink-0">{priceUnitLabel}</span>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[9px] font-bold text-neutral-400 transition hover:text-white"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{detailLabel}（名前・メーカー・品番・URL・メモ）</span>
        {hasDetail && !open && <span className="text-emerald-400">●</span>}
      </button>

      {open && (
        <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/20 p-1.5">
          {text('name', '名前', placeholders?.name)}
          {text('brand', 'メーカー', placeholders?.brand)}
          {text('modelNumber', '品番', placeholders?.modelNumber)}
          <div className="flex items-center gap-1">
            <span className={`${labelClass} w-[52px]`}>URL</span>
            <input
              type="url"
              value={values.productUrl ?? ''}
              placeholder={placeholders?.productUrl || 'https://…'}
              onChange={(e) => onChange({ productUrl: e.target.value })}
              onBlur={onCommit}
              className={inputClass}
            />
            {isOpenableUrl(values.productUrl ?? placeholders?.productUrl) && (
              <a
                href={(values.productUrl ?? placeholders?.productUrl ?? '').trim()}
                target="_blank"
                rel="noopener noreferrer"
                title="商品ページを開く"
                className="shrink-0 rounded px-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300"
              >
                ↗
              </a>
            )}
          </div>
          <input
            value={values.memo ?? ''}
            placeholder="メモ（任意）"
            onChange={(e) => onChange({ memo: e.target.value })}
            onBlur={onCommit}
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
};
