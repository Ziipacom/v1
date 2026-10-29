import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ImagePlus,
  Package,
  Plus,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Store,
  X,
} from "lucide-react-native";
import { Action, Field, Pill } from "./ui";
import { Disclosure } from "./disclosure";
import { FloatButton } from "./floating";
import {
  centsFromText,
  productCategories,
  type ListingDraft,
} from "../lib/commerce";
import { sellSteps, type SellStep } from "../lib/store-flow";
import { color, font, styles } from "../theme";

type Props = {
  step: SellStep;
  onStep: (step: SellStep) => void;
  draft: ListingDraft;
  onChange: (value: Partial<ListingDraft>) => void;
  price: string;
  onPrice: (value: string) => void;
  prompt: string;
  onPrompt: (value: string) => void;
  consent: boolean;
  onConsent: () => void;
  busy: string;
  preview: ReactNode;
  onUpload: () => void;
  onCamera?: () => void;
  onGenerate: () => void;
  onSave: (status: ListingDraft["status"]) => void;
  onStore: () => void;
  onProducts: () => void;
  onNew: () => void;
  storeName: string;
  storeEnabled: boolean;
  onEnableStore: () => void;
};

function Choice({
  title,
  value,
  onPress,
  disabled,
}: {
  title: string;
  value: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={title}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
      }}
    >
      <View
        style={{
          width: 21,
          height: 21,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: value ? color.lime : color.muted,
          backgroundColor: value ? color.lime : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value && <Check size={15} color={color.bg} />}
      </View>
      <Text style={[styles.small, { flex: 1 }]}>{title}</Text>
    </Pressable>
  );
}

export function StoreSellWizard(props: Props) {
  const [details, setDetails] = useState(false);
  const [display, setDisplay] = useState(false);
  const { draft, step, busy, onChange } = props;
  const ready = !!draft.title.trim() && centsFromText(props.price) !== null;
  const icons = { create: Sparkles, review: SlidersHorizontal, publish: Check };
  const input = { editable: !busy };
  return (
    <View style={{ gap: 16 }} testID="store-sell-wizard">
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={[styles.heading, { fontSize: 22 }]}>Sell with Ziipa</Text>
        <View style={{ flexDirection: "row" }}>
          <FloatButton
            icon={Plus}
            label="New product"
            plain
            size={40}
            onPress={props.onNew}
          />
          <FloatButton
            icon={Store}
            label="Storefront settings"
            plain
            size={40}
            onPress={props.onStore}
          />
          <FloatButton
            icon={ShoppingBag}
            label="Your products"
            plain
            size={40}
            onPress={props.onProducts}
          />
        </View>
      </View>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          borderBottomWidth: 1,
          borderColor: color.border,
        }}
      >
        {sellSteps.map((entry, index) => {
          const Icon = icons[entry.id];
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              aria-selected={step === entry.id}
              accessibilityLabel={`${index + 1}. ${entry.title}`}
              accessibilityState={{
                selected: step === entry.id,
                disabled: !!busy,
              }}
              disabled={!!busy}
              onPress={() => props.onStep(entry.id)}
              style={{
                flex: 1,
                alignItems: "center",
                gap: 5,
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderColor: step === entry.id ? color.lime : "transparent",
              }}
            >
              <Icon
                size={19}
                color={step === entry.id ? color.lime : color.muted}
              />
              <Text
                style={{
                  color: step === entry.id ? color.text : color.muted,
                  fontFamily: font.medium,
                  fontSize: 11,
                }}
              >
                {entry.title}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {step === "create" && (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View style={{ width: 106 }}>{props.preview}</View>
            <View style={{ flex: 1, gap: 8 }}>
              <Action
                title={busy.startsWith("Uploading photo") ? busy : "Add photos"}
                icon={ImagePlus}
                secondary
                disabled={!!busy || draft.photo_ids.length >= 6}
                onPress={props.onUpload}
              />
              {props.onCamera && (
                <Action
                  title="Take photo"
                  icon={Camera}
                  secondary
                  disabled={!!busy || draft.photo_ids.length >= 6}
                  onPress={props.onCamera}
                />
              )}
              <Text style={styles.small}>
                {draft.photo_ids.length}/6 photos
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pill
              title="Digital media"
              active={draft.kind === "digital"}
              onPress={() =>
                onChange({ kind: "digital", condition: "not_applicable" })
              }
            />
            <Pill
              title="Merchandise"
              active={draft.kind === "merchandise"}
              onPress={() =>
                onChange({
                  kind: "merchandise",
                  category: "merch",
                  condition: "new",
                })
              }
            />
          </View>
          <Field
            {...input}
            label="What are you selling?"
            placeholder="An original music EP, or a branded hoodie…"
            value={props.prompt}
            onChangeText={props.onPrompt}
            maxLength={1600}
            multiline
          />
          <Choice
            title="Use my description for AI listing copy."
            value={props.consent}
            disabled={!!busy}
            onPress={props.onConsent}
          />
          <Action
            title="Create for Me"
            icon={Sparkles}
            disabled={
              !!busy || !props.consent || props.prompt.trim().length < 8
            }
            busy={busy === "Preparing suggestions"}
            onPress={props.onGenerate}
          />
          <Text style={[styles.small, { fontSize: 12, lineHeight: 16 }]}>
            AI prepares your listing copy. Review the price and final display.
          </Text>
          <Action
            title="Continue without AI"
            secondary
            disabled={!!busy}
            onPress={() => {
              if (!draft.description && props.prompt.trim())
                onChange({ description: props.prompt.trim() });
              props.onStep("review");
            }}
          />
        </View>
      )}
      {step === "review" && (
        <View style={{ gap: 12 }}>
          <View style={{ width: 170, alignSelf: "center" }}>
            {props.preview}
          </View>
          <Field
            {...input}
            label="Title"
            value={draft.title}
            maxLength={100}
            onChangeText={(title) => onChange({ title })}
          />
          <Field
            {...input}
            label="Your price · USD"
            value={props.price}
            onChangeText={props.onPrice}
            placeholder="0.00"
            keyboardType="decimal-pad"
            maxLength={10}
          />
          <Disclosure
            title="Product details"
            detail={
              productCategories.find((entry) => entry.id === draft.category)
                ?.title || "Description & category"
            }
            icon={Package}
            expanded={details}
            onToggle={() => setDetails(!details)}
          >
            <Field
              {...input}
              label="Description"
              value={draft.description}
              maxLength={3000}
              multiline
              onChangeText={(description) => onChange({ description })}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {productCategories.map((entry) => (
                <Pill
                  key={entry.id}
                  title={entry.title}
                  active={draft.category === entry.id}
                  onPress={() => onChange({ category: entry.id })}
                />
              ))}
            </View>
            {draft.kind === "merchandise" && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {(
                  [
                    ["new", "New"],
                    ["like_new", "Like new"],
                    ["good", "Good"],
                    ["fair", "Fair"],
                  ] as const
                ).map(([condition, title]) => (
                  <Pill
                    key={condition}
                    title={title}
                    active={draft.condition === condition}
                    onPress={() => onChange({ condition })}
                  />
                ))}
              </View>
            )}
          </Disclosure>
          <Disclosure
            title="Display & photos"
            detail={`${draft.photo_ids.length} photos · editable overlays`}
            icon={ImagePlus}
            expanded={display}
            onToggle={() => setDisplay(!display)}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(
                [
                  ["none", "Photo only"],
                  ["price", "Price"],
                  ["editorial", "Title + price"],
                ] as const
              ).map(([overlay, title]) => (
                <Pill
                  key={overlay}
                  title={title}
                  active={draft.overlay === overlay}
                  onPress={() => onChange({ overlay })}
                />
              ))}
            </View>
            <Field
              {...input}
              label="Display caption"
              value={draft.descriptor}
              maxLength={80}
              onChangeText={(descriptor) => onChange({ descriptor })}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {draft.photo_ids.map((id, index) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove product photo ${index + 1}`}
                  disabled={!!busy}
                  onPress={() =>
                    onChange({
                      photo_ids: draft.photo_ids.filter(
                        (value) => value !== id,
                      ),
                    })
                  }
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    padding: 10,
                    backgroundColor: color.panel,
                  }}
                >
                  <Text style={styles.small}>Photo {index + 1}</Text>
                  <X size={15} color={color.text} />
                </Pressable>
              ))}
            </View>
            <Action
              title="Add photos"
              secondary
              disabled={!!busy || draft.photo_ids.length >= 6}
              onPress={props.onUpload}
            />
          </Disclosure>
          <Action
            title="Continue to publish"
            icon={ArrowRight}
            disabled={!!busy || !ready}
            onPress={() => props.onStep("publish")}
          />
        </View>
      )}
      {step === "publish" && (
        <View style={{ gap: 12 }}>
          <Text style={[styles.body, { fontFamily: font.semibold }]}>
            {draft.title || "Your product"}
          </Text>
          <Field
            {...input}
            label={
              draft.kind === "digital"
                ? "Delivery & license"
                : "Shipping or collection"
            }
            value={draft.delivery}
            maxLength={300}
            multiline
            onChangeText={(delivery) => onChange({ delivery })}
            placeholder={
              draft.kind === "digital"
                ? "Format, delivery method and permitted use"
                : "Delivery locations, timing and costs"
            }
          />
          <Choice
            title="I own or have permission to sell this product and its photos."
            value={draft.rights_confirmed}
            disabled={!!busy}
            onPress={() =>
              onChange({ rights_confirmed: !draft.rights_confirmed })
            }
          />
          <Choice
            title="I am 18 or older and responsible for accurate product details."
            value={draft.adult_seller}
            disabled={!!busy}
            onPress={() => onChange({ adult_seller: !draft.adult_seller })}
          />
          <Choice
            title={`Display my storefront and its published products · ${props.storeName || "My store"}`}
            value={props.storeEnabled}
            disabled={!!busy}
            onPress={props.onEnableStore}
          />
          <Text style={styles.small}>
            Listing only. Checkout and seller payouts are not available yet.
          </Text>
          <Action
            title="Save privately"
            secondary
            icon={Check}
            disabled={!!busy || !draft.title.trim()}
            busy={busy === "Saving product"}
            onPress={() => props.onSave("draft")}
          />
          <Action
            title="Publish listing"
            icon={ArrowRight}
            disabled={
              !!busy ||
              !ready ||
              !draft.rights_confirmed ||
              !draft.adult_seller ||
              !draft.photo_ids.length ||
              !props.storeEnabled
            }
            busy={busy === "Publishing product"}
            onPress={() => props.onSave("published")}
          />
          {!!draft.id && (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Action
                  title="Mark sold"
                  secondary
                  disabled={!!busy}
                  onPress={() => props.onSave("sold")}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Action
                  title="Archive"
                  secondary
                  disabled={!!busy}
                  onPress={() => props.onSave("archived")}
                />
              </View>
            </View>
          )}
        </View>
      )}
      {step !== "create" && (
        <Action
          title="Back"
          icon={ArrowLeft}
          secondary
          disabled={!!busy}
          onPress={() => props.onStep(step === "publish" ? "review" : "create")}
        />
      )}
    </View>
  );
}
