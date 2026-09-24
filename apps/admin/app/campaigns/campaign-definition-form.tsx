'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { CampaignRuleError } from '../../lib/api';
import {
  ARGUMENT_LABELS,
  CAMPAIGN_CHANNEL_OPTIONS,
  CAMPAIGN_RULES_CATALOG,
  CAMPAIGN_TRIGGER_OPTIONS,
  ENUM_VALUE_LABELS,
  FACT_LABELS,
  MOBILE_CHANNEL_WARNING,
  STACK_POLICY_LABEL,
  TRIGGER_LABELS,
  argumentSpecsOf,
  buildDefinition,
  channelLabel,
  conditionOptionsFor,
  errorFieldOf,
  isEligibilityTrigger,
  newConditionRow,
  ruleErrorMessage,
  type CampaignFact,
  type CampaignForm,
  type CampaignTrigger,
  type ConditionRow,
  type ErrorTarget,
} from '../../lib/campaign-rules';
import { campaignFormAction } from './actions';
import { IDLE_CAMPAIGN_FORM_STATE } from './form-state';

/**
 * The campaign builder: every choice is a selection from the shared
 * catalogue, and the only free text is the campaign's name and key.
 *
 * The form keeps its own state and assembles a definition from it on every
 * render; that definition travels to the server action as one hidden JSON
 * field. There is no JSON editor: an operator cannot type a field the
 * catalogue does not offer, and what they can type (numbers, slugs) is
 * carried as-is for the API to judge. When the API refuses, each error is
 * placed beside the input its path names; when it accepts, the summary it
 * returned is shown — and the sentence that the engine is off and this is a
 * draft stays on screen throughout.
 */

type Props = {
  mode: 'create' | 'revise';
  campaignId?: string;
  campaignName?: string;
  initialForm: CampaignForm;
  /** The version being revised, for the heading. */
  revisingVersionNumber?: number;
};

const CATALOG = CAMPAIGN_RULES_CATALOG;

export function CampaignDefinitionForm({
  mode,
  campaignId,
  campaignName,
  initialForm,
  revisingVersionNumber,
}: Props) {
  const [state, formAction] = useActionState(campaignFormAction, IDLE_CAMPAIGN_FORM_STATE);
  const [form, setForm] = useState<CampaignForm>(initialForm);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');

  const definition = useMemo(() => buildDefinition(form), [form]);
  const definitionJson = useMemo(() => JSON.stringify(definition), [definition]);

  const errorsByTarget = useMemo(() => groupErrors(state.errors, form), [state.errors, form]);
  const fieldError = (field: string) => errorsByTarget.fields.get(field) ?? [];
  const conditionError = (row: ConditionRow, argument: string | null) =>
    errorsByTarget.conditions.get(`${row.id}:${argument ?? ''}`) ?? [];

  const update = <K extends keyof CampaignForm>(field: K, value: CampaignForm[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const setTrigger = (trigger: CampaignTrigger) => {
    // Conditions the new trigger does not allow are dropped rather than
    // carried into a definition the API would refuse with a mismatch.
    const allowed = new Set(conditionOptionsFor(trigger).map((option) => option.value));
    setForm((current) => ({
      ...current,
      trigger,
      facts: isEligibilityTrigger(trigger) ? current.facts : [],
      conditions: current.conditions.filter((row) => row.type === '' || allowed.has(row.type)),
    }));
  };

  const toggleFact = (fact: CampaignFact) =>
    setForm((current) => ({
      ...current,
      facts: current.facts.includes(fact)
        ? current.facts.filter((item) => item !== fact)
        : [...current.facts, fact],
    }));

  const updateRow = (id: string, patch: Partial<ConditionRow>) =>
    setForm((current) => ({
      ...current,
      conditions: current.conditions.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));

  const updateRowArg = (id: string, argument: string, value: string | string[]) =>
    setForm((current) => ({
      ...current,
      conditions: current.conditions.map((row) =>
        row.id === id ? { ...row, args: { ...row.args, [argument]: value } } : row,
      ),
    }));

  const removeRow = (id: string) =>
    setForm((current) => ({
      ...current,
      conditions: current.conditions.filter((row) => row.id !== id),
    }));

  const conditionOptions = conditionOptionsFor(form.trigger);
  const eligibility = isEligibilityTrigger(form.trigger);

  return (
    <form action={formAction} className="compact-form compact-form-wide campaign-form" data-testid="campaign-form">
      <input type="hidden" name="definition" value={definitionJson} />
      {campaignId ? <input type="hidden" name="campaignId" value={campaignId} /> : null}

      <div className="notice notice-warning campaign-engine-notice" role="note" data-testid="campaign-engine-notice">
        <strong>Kaydetmek etkinleştirmez.</strong> Bu form yalnızca değiştirilemez bir sürüm kaydeder; çalışan kural
        ancak kampanya ayrıntısındaki yaşam döngüsü panelinden, motor açıkken etkinleştirilir. Kaydetme hiçbir olay
        değerlendirmez, hiçbir hizmet verene kredi vermez.
      </div>

      {mode === 'create' ? (
        <fieldset className="campaign-fieldset">
          <legend>Kimlik</legend>
          <div className="compact-field-grid">
            <label className="field field-6">
              <span>Kampanya adı *</span>
              <input name="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label className="field field-6">
              <span>Anahtar *</span>
              <input
                name="key"
                required
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="ornek-kampanya"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <span className="help-text">Yalnızca küçük harf, rakam ve tire. Sonradan değişmez.</span>
            </label>
          </div>
        </fieldset>
      ) : (
        <p className="campaign-revise-heading">
          <strong>{campaignName}</strong> — sürüm {revisingVersionNumber} üzerinden yeni revizyon. Kaydetmek
          önceki sürümü değiştirmez; yeni bir sürüm numarası üretir.
        </p>
      )}

      <fieldset className="campaign-fieldset" data-testid="campaign-trigger">
        <legend>Tetikleyici</legend>
        <FieldErrors errors={fieldError('trigger')} />
        <div className="campaign-radio-list" role="radiogroup" aria-label="Tetikleyici">
          {CAMPAIGN_TRIGGER_OPTIONS.map((option) => (
            <label key={option.value} className={`campaign-radio${form.trigger === option.value ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="trigger-choice"
                value={option.value}
                checked={form.trigger === option.value}
                onChange={() => setTrigger(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.help}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="campaign-fieldset" data-testid="campaign-channel" data-channel={form.channel}>
        <legend>Kanal</legend>
        <p className="help-text">
          Kanal, olayın kaynağından sunucuda belirlenir; istemcinin beyanı kullanılmaz. Kanal sürümün parçasıdır:
          değiştirmek yeni bir sürüm kaydeder, çalışan sürüm yerinde değişmez.
        </p>
        <FieldErrors errors={fieldError('channel')} />
        <div className="campaign-radio-list" role="radiogroup" aria-label="Kanal">
          {CAMPAIGN_CHANNEL_OPTIONS.map((option) => (
            <label key={option.value} className={`campaign-radio${form.channel === option.value ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="channel-choice"
                value={option.value}
                checked={form.channel === option.value}
                onChange={() => update('channel', option.value)}
                data-testid={`campaign-channel-${option.value}`}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.help}</small>
              </span>
            </label>
          ))}
        </div>
        {form.channel === 'MOBILE' ? (
          <div className="notice notice-warning" role="note" data-testid="campaign-channel-mobile-warning">
            {MOBILE_CHANNEL_WARNING}
          </div>
        ) : null}
      </fieldset>

      {eligibility ? (
        <fieldset className="campaign-fieldset" data-testid="campaign-facts">
          <legend>Olgu kümesi</legend>
          <p className="help-text">
            Seçilen olguların tamamı ilk kez birlikte doğru olduğunda kampanya değerlendirilir ({CATALOG.factSet.min}–
            {CATALOG.factSet.max} olgu).
          </p>
          <FieldErrors errors={fieldError('facts')} />
          <div className="checkbox-group">
            {CATALOG.facts.map((fact) => (
              <label key={fact} className="checkbox-row">
                <input type="checkbox" checked={form.facts.includes(fact)} onChange={() => toggleFact(fact)} />
                {FACT_LABELS[fact]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="campaign-fieldset" data-testid="campaign-conditions">
        <legend>Koşullar</legend>
        <p className="help-text">
          &ldquo;Zorunlu&rdquo; koşulların hepsi, &ldquo;alternatif&rdquo; koşulların en az biri sağlanmalıdır.
          Koşul yoksa tetikleyici tek başına yeter.
        </p>
        <FieldErrors errors={fieldError('conditions')} />
        {form.conditions.length === 0 ? (
          <p className="campaign-empty-rows">Henüz koşul eklenmedi.</p>
        ) : (
          <ol className="campaign-condition-list">
            {form.conditions.map((row, index) => (
              <li key={row.id} className="campaign-condition" data-testid="campaign-condition-row">
                <div className="campaign-condition-head">
                  <span className="campaign-condition-index">{index + 1}</span>
                  <label className="field campaign-condition-type">
                    <span>Koşul</span>
                    <select
                      value={row.type}
                      aria-label={`Koşul ${index + 1} türü`}
                      onChange={(e) => updateRow(row.id, { type: e.target.value as ConditionRow['type'], args: {} })}
                    >
                      <option value="">Seçin…</option>
                      {conditionOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field campaign-condition-group">
                    <span>Grup</span>
                    <select
                      value={row.group}
                      aria-label={`Koşul ${index + 1} grubu`}
                      onChange={(e) => updateRow(row.id, { group: e.target.value as ConditionRow['group'] })}
                    >
                      <option value="all">Zorunlu (hepsi)</option>
                      <option value="any">Alternatif (en az biri)</option>
                    </select>
                  </label>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeRow(row.id)}>
                    Kaldır
                  </button>
                </div>
                <FieldErrors errors={conditionError(row, null)} />
                <ConditionArguments row={row} onChange={updateRowArg} errorsFor={(argument) => conditionError(row, argument)} />
              </li>
            ))}
          </ol>
        )}
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="campaign-add-condition"
            onClick={() => setForm((current) => ({ ...current, conditions: [...current.conditions, newConditionRow()] }))}
          >
            Koşul ekle
          </button>
        </div>
      </fieldset>

      <fieldset className="campaign-fieldset" data-testid="campaign-benefit">
        <legend>Fayda</legend>
        <div className="compact-field-grid">
          <label className="field field-4">
            <span>Fayda türü</span>
            <input value="Promosyon kredisi (süreli)" readOnly aria-readonly="true" />
            <span className="help-text">Bu sürümde tek fayda türü.</span>
          </label>
          <NumberField
            className="field field-4"
            label={`Kredi * (${CATALOG.benefit.credits.min}–${CATALOG.benefit.credits.max})`}
            name="credits"
            value={form.credits}
            onChange={(value) => update('credits', value)}
            errors={fieldError('credits')}
            testId="campaign-credits"
          />
          <NumberField
            className="field field-4"
            label={`Son kullanma (gün) * (${CATALOG.benefit.expiresInDays.min}–${CATALOG.benefit.expiresInDays.max})`}
            name="expiresInDays"
            value={form.expiresInDays}
            onChange={(value) => update('expiresInDays', value)}
            errors={fieldError('expiresInDays')}
            testId="campaign-expires-in-days"
          />
        </div>
      </fieldset>

      <fieldset className="campaign-fieldset" data-testid="campaign-limits">
        <legend>Limitler ve bütçe</legend>
        <div className="compact-field-grid">
          <NumberField
            className="field field-3"
            label="Hizmet veren başına *"
            name="maxRedemptionsPerProvider"
            value={form.maxRedemptionsPerProvider}
            onChange={(value) => update('maxRedemptionsPerProvider', value)}
            errors={fieldError('maxRedemptionsPerProvider')}
            help={`${CATALOG.limits.maxRedemptionsPerProvider.min}–${CATALOG.limits.maxRedemptionsPerProvider.max}`}
          />
          <NumberField
            className="field field-3"
            label="Toplam"
            name="maxRedemptionsGlobal"
            value={form.maxRedemptionsGlobal}
            onChange={(value) => update('maxRedemptionsGlobal', value)}
            errors={fieldError('maxRedemptionsGlobal')}
            help="Boş = sınırsız"
          />
          <NumberField
            className="field field-3"
            label="Günlük"
            name="maxRedemptionsPerDay"
            value={form.maxRedemptionsPerDay}
            onChange={(value) => update('maxRedemptionsPerDay', value)}
            errors={fieldError('maxRedemptionsPerDay')}
            help="Boş = sınırsız"
          />
          <NumberField
            className="field field-3"
            label="Kredi bütçesi"
            name="budgetCredits"
            value={form.budgetCredits}
            onChange={(value) => update('budgetCredits', value)}
            errors={fieldError('budgetCredits')}
            help="Boş = sınırsız"
          />
          <NumberField
            className="field field-3"
            label="Günlük geri alma eşiği"
            name="maxRevokesPerDay"
            value={form.maxRevokesPerDay}
            onChange={(value) => update('maxRevokesPerDay', value)}
            errors={fieldError('maxRevokesPerDay')}
            help={`Boş = kapalı; ${CATALOG.limits.maxRevokesPerDay.min}–${CATALOG.limits.maxRevokesPerDay.max}. Aşılınca kampanya kendini duraklatır (UTC günü).`}
          />
        </div>
      </fieldset>

      <fieldset className="campaign-fieldset" data-testid="campaign-window">
        <legend>Zaman penceresi ve öncelik</legend>
        <div className="compact-field-grid">
          <label className="field field-4">
            <span>Başlangıç (UTC)</span>
            <input type="datetime-local" value={form.windowStartAt} onChange={(e) => update('windowStartAt', e.target.value)} aria-invalid={fieldError('windowStartAt').length > 0} />
            <FieldErrors errors={fieldError('windowStartAt')} />
          </label>
          <label className="field field-4">
            <span>Bitiş (UTC)</span>
            <input type="datetime-local" value={form.windowEndAt} onChange={(e) => update('windowEndAt', e.target.value)} aria-invalid={fieldError('windowEndAt').length > 0} />
            <FieldErrors errors={fieldError('windowEndAt')} />
          </label>
          <NumberField
            className="field field-4"
            label={`Öncelik * (${CATALOG.priority.min}–${CATALOG.priority.max})`}
            name="priority"
            value={form.priority}
            onChange={(value) => update('priority', value)}
            errors={fieldError('priority')}
            help="Aynı olayda eşit kredide küçük değer kazanır."
          />
          <label className="field field-12">
            <span>Stack politikası</span>
            <input value={STACK_POLICY_LABEL} readOnly aria-readonly="true" />
          </label>
        </div>
      </fieldset>

      <ResultPanel state={state} form={form} />

      <div className="compact-actions">
        <SubmitButton intent="validate" className="btn btn-secondary btn-sm" testId="campaign-validate">
          Doğrula
        </SubmitButton>
        <SubmitButton intent="save" className="btn btn-primary btn-sm" testId="campaign-save">
          {mode === 'create' ? 'Taslağı kaydet' : 'Revizyonu kaydet'}
        </SubmitButton>
        <Link className="btn btn-ghost btn-sm" href={campaignId ? `/campaigns/${campaignId}` : '/campaigns'}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}

// ───────────────────────────── pieces ─────────────────────────────

function SubmitButton({
  intent,
  className,
  testId,
  children,
}: {
  intent: 'validate' | 'save';
  className: string;
  testId: string;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name="intent" value={intent} className={className} disabled={pending} data-testid={testId}>
      {pending ? 'Gönderiliyor…' : children}
    </button>
  );
}

function NumberField({
  className,
  label,
  name,
  value,
  onChange,
  errors,
  help,
  testId,
}: {
  className: string;
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  errors: string[];
  help?: string;
  testId?: string;
}) {
  return (
    <label className={className}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        name={`field-${name}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={errors.length > 0}
        data-testid={testId}
      />
      {help ? <span className="help-text">{help}</span> : null}
      <FieldErrors errors={errors} />
    </label>
  );
}

function FieldErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="campaign-field-errors" data-testid="campaign-field-error">
      {errors.map((message, index) => (
        <li key={index}>{message}</li>
      ))}
    </ul>
  );
}

function ConditionArguments({
  row,
  onChange,
  errorsFor,
}: {
  row: ConditionRow;
  onChange: (id: string, argument: string, value: string | string[]) => void;
  errorsFor: (argument: string) => string[];
}) {
  const specs = Object.entries(argumentSpecsOf(row.type));
  if (specs.length === 0) return null;
  return (
    <div className="compact-field-grid campaign-condition-args">
      {specs.map(([argument, spec]) => {
        const label = ARGUMENT_LABELS[argument] ?? argument;
        const errors = errorsFor(argument);
        const raw = row.args[argument];
        if (spec.kind === 'enumList') {
          const selected = Array.isArray(raw) ? raw : [];
          return (
            <div key={argument} className="field field-12">
              <span>{label}</span>
              <div className="checkbox-group">
                {spec.values.map((value) => (
                  <label key={value} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={selected.includes(value)}
                      onChange={() =>
                        onChange(
                          row.id,
                          argument,
                          selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
                        )
                      }
                    />
                    {ENUM_VALUE_LABELS[value] ?? value}
                  </label>
                ))}
              </div>
              <FieldErrors errors={errors} />
            </div>
          );
        }
        if (spec.kind === 'enum') {
          const value = typeof raw === 'string' && raw !== '' ? raw : spec.values[0]!;
          return (
            <label key={argument} className="field field-6">
              <span>{label}</span>
              <select value={value} onChange={(e) => onChange(row.id, argument, e.target.value)} aria-invalid={errors.length > 0}>
                {spec.values.map((option) => (
                  <option key={option} value={option}>
                    {ENUM_VALUE_LABELS[option] ?? option}
                  </option>
                ))}
              </select>
              <FieldErrors errors={errors} />
            </label>
          );
        }
        return (
          <label key={argument} className={spec.kind === 'slugList' ? 'field field-12' : 'field field-6'}>
            <span>
              {label}
              {spec.kind === 'integer' ? ` (${spec.min}–${spec.max})` : ''}
            </span>
            <input
              type="text"
              inputMode={spec.kind === 'integer' ? 'numeric' : 'text'}
              value={typeof raw === 'string' ? raw : ''}
              onChange={(e) => onChange(row.id, argument, e.target.value)}
              aria-invalid={errors.length > 0}
              placeholder={spec.kind === 'slugList' ? 'paket-1, paket-2' : undefined}
            />
            <FieldErrors errors={errors} />
          </label>
        );
      })}
    </div>
  );
}

function ResultPanel({
  state,
  form,
}: {
  state: { status: string; errors: CampaignRuleError[]; summary: { conditionCount: number; factSetKey: string | null; benefitCredits: number; benefitExpiresInDays: number; trigger: string; channel?: string } | null; message: string | null };
  form: CampaignForm;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'error') {
    return (
      <div className="notice notice-error" role="alert" data-testid="campaign-result">
        {state.message}
      </div>
    );
  }
  if (state.status === 'invalid') {
    return (
      <div className="notice notice-error" role="alert" data-testid="campaign-result" data-valid="false">
        <strong>Tanım doğrulamadan geçmedi ({state.errors.length} hata).</strong> Hiçbir şey kaydedilmedi.
        <ul className="campaign-error-summary">
          {state.errors.map((error, index) => (
            <li key={index}>
              <code>{error.code}</code> — {ruleErrorMessage(error.code, error.message)}
              {describeTarget(errorFieldOf(error.path, form))}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const summary = state.summary;
  return (
    <div className="notice notice-success" role="status" data-testid="campaign-result" data-valid="true">
      <strong>Tanım geçerli.</strong> Henüz kaydedilmedi; kaydettiğinizde yeni bir taslak sürümü oluşur. Motor
      kapalı olduğundan kayıt kredi vermez.
      {summary ? (
        <dl className="campaign-summary">
          <dt>Tetikleyici</dt>
          <dd>{TRIGGER_LABELS[summary.trigger as CampaignTrigger] ?? summary.trigger}</dd>
          {summary.factSetKey ? (
            <>
              <dt>Olgu kümesi</dt>
              <dd>
                <code>{summary.factSetKey}</code>
              </dd>
            </>
          ) : null}
          <dt>Kanal</dt>
          <dd data-testid="campaign-result-channel">{channelLabel(summary.channel)}</dd>
          <dt>Koşul sayısı</dt>
          <dd>{summary.conditionCount}</dd>
          <dt>Fayda</dt>
          <dd>
            {summary.benefitCredits} promosyon kredisi, {summary.benefitExpiresInDays} gün
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

function describeTarget(target: ErrorTarget): string {
  if (target.field === 'condition') {
    return target.argument ? ` (koşul alanı: ${ARGUMENT_LABELS[target.argument] ?? target.argument})` : ' (koşul)';
  }
  if (target.field === 'form') return '';
  return ` (alan: ${FIELD_TITLES[target.field] ?? target.field})`;
}

const FIELD_TITLES: Record<string, string> = {
  trigger: 'tetikleyici',
  facts: 'olgu kümesi',
  conditions: 'koşullar',
  credits: 'kredi',
  expiresInDays: 'son kullanma',
  priority: 'öncelik',
  channel: 'kanal',
  maxRedemptionsPerProvider: 'hizmet veren başına limit',
  maxRedemptionsGlobal: 'toplam limit',
  maxRedemptionsPerDay: 'günlük limit',
  budgetCredits: 'kredi bütçesi',
  maxRevokesPerDay: 'günlük geri alma eşiği',
  windowStartAt: 'başlangıç',
  windowEndAt: 'bitiş',
};

function groupErrors(errors: CampaignRuleError[], form: CampaignForm) {
  const fields = new Map<string, string[]>();
  const conditions = new Map<string, string[]>();
  for (const error of errors) {
    const message = ruleErrorMessage(error.code, error.message);
    const target = errorFieldOf(error.path, form);
    if (target.field === 'form') {
      // Shown in the result panel's list, which carries every error anyway.
      continue;
    } else if (target.field === 'condition') {
      const key = `${target.conditionId}:${target.argument ?? ''}`;
      conditions.set(key, [...(conditions.get(key) ?? []), message]);
    } else {
      fields.set(target.field, [...(fields.get(target.field) ?? []), message]);
    }
  }
  return { fields, conditions };
}
