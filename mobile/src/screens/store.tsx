import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import {
  Check,
  Package,
  RefreshCw,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Store,
} from "lucide-react-native";
import { useZiipa } from "../provider";
import { color, font, styles, useTheme } from "../theme";
import { Action, Empty, Field, Notice, Pill } from "../components/ui";
import { FloatButton, Sheet } from "../components/floating";
import { useDesktopLayout } from "../components/desktop-layout";
import { Disclosure } from "../components/disclosure";
import { StoreSellWizard } from "../components/store-sell-wizard";
import { applyListingSuggestion, type SellStep } from "../lib/store-flow";
import { uploadMedia } from "../lib/api";
import { iosLimitedTestflight } from "../lib/config";
import { useStorePhotoSource } from "../lib/store-photo-source";
import { serviceOptions, restoreServices } from "../lib/service-purchases";
import {
  centsFromText,
  editListing,
  emptyListing,
  marketplaceSearch,
  money,
  productCategories,
  type Listing,
  type ListingDraft,
  type MarketPage,
  type PurchaseContext,
  type PurchaseOption,
  type Services,
  type StoreMine,
  type Storefront,
  type Suggestion,
} from "../lib/commerce";
import type { RootStack } from "../lib/types";

function ProductDisplay({
  item,
  path,
  large = false,
  tile = false,
}: {
  item: Pick<ListingDraft, "title" | "price_cents" | "descriptor" | "overlay">;
  path?: string;
  large?: boolean;
  tile?: boolean;
}) {
  const { session } = useZiipa();
  const source = useStorePhotoSource(path, session?.access_token);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path, session?.access_token]);
  useEffect(() => {
    if (source) {
      setFailed(false);
      return;
    }
    if (!path) return;
    const timer = setTimeout(() => setFailed(true), 15000);
    return () => clearTimeout(timer);
  }, [path, source]);
  return (
    <View
      style={{
        aspectRatio: 1,
        borderRadius: tile ? 0 : 18,
        overflow: "hidden",
        backgroundColor: color.raised,
      }}
    >
      {source && !failed ? (
        <Image
          source={source}
          resizeMode="cover"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
          }}
        >
          <Package color={color.muted} size={32} />
          <Text style={styles.small}>
            {path
              ? failed
                ? "Photo unavailable · reload to retry"
                : "Loading product photo…"
              : "Your product photo"}
          </Text>
        </View>
      )}
      {!tile && item.overlay !== "none" && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 12,
            gap: 7,
          }}
        >
          {item.overlay === "editorial" && (
            <View
              style={{
                backgroundColor: "#10091DD9",
                padding: large ? 16 : 11,
                borderRadius: 12,
              }}
            >
              <Text
                numberOfLines={2}
                style={{
                  color: "#FFF",
                  fontFamily: font.bold,
                  fontSize: large ? 28 : 18,
                }}
              >
                {item.title || "Make room for your next favorite."}
              </Text>
              {!!item.descriptor && (
                <Text
                  style={{
                    color: "#EEE3FF",
                    marginTop: 5,
                    fontSize: large ? 16 : 12,
                  }}
                >
                  {item.descriptor}
                </Text>
              )}
            </View>
          )}
          <View
            style={{
              backgroundColor: "#D7FF9F",
              alignSelf: "flex-start",
              borderRadius: 24,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text
              style={{
                color: "#17210C",
                fontFamily: font.bold,
                fontSize: large ? 20 : 15,
              }}
            >
              {money(item.price_cents)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

function Toggle({
  value,
  title,
  onChange,
  disabled = false,
}: {
  value: boolean;
  title: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onChange}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      style={{
        flexDirection: "row",
        gap: 10,
        alignItems: "center",
        minHeight: 46,
      }}
    >
      <View
        style={{
          width: 23,
          height: 23,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: color.muted,
          backgroundColor: value ? color.purple : color.panel,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value && <Check size={17} color="#FFF" />}
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{title}</Text>
    </Pressable>
  );
}

export function StoreScreen(props: NativeStackScreenProps<RootStack, "Store">) {
  const { session } = useZiipa();
  return (
    <ScopedStoreScreen key={session?.access_token || "guest"} {...props} />
  );
}

function ScopedStoreScreen({
  navigation,
  route,
}: NativeStackScreenProps<RootStack, "Store">) {
  useTheme();
  const { desktop } = useDesktopLayout();
  const { session, guest, api } = useZiipa();
  const [tab, setTab] = useState<"browse" | "sell" | "services">(
    route.params?.tab || "browse",
  );
  const [mine, setMine] = useState<StoreMine | null>(null);
  const [store, setStore] = useState<Storefront | null>(null);
  const [services, setServices] = useState<Services | null>(null);
  const [items, setItems] = useState<Listing[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [sellerStore, setSellerStore] =
    useState<MarketPage["storefront"]>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState("newest");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [filters, setFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ListingDraft>(emptyListing);
  const [price, setPrice] = useState("");
  const [prompt, setPrompt] = useState("");
  const [consent, setConsent] = useState(false);
  const [sellStep, setSellStep] = useState<SellStep>("create");
  const [selected, setSelected] = useState<Listing | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState(0);
  const [photoEpoch, setPhotoEpoch] = useState(0);
  const [photoPaths, setPhotoPaths] = useState<Record<string, string>>({});
  const [purchaseContext, setPurchaseContext] =
    useState<PurchaseContext | null>(null);
  const [options, setOptions] = useState<PurchaseOption[]>([]);
  const [openSellPanel, setOpenSellPanel] = useState<string | null>(null);
  const [openServicePanel, setOpenServicePanel] = useState<string | null>(null);
  const [openFeature, setOpenFeature] = useState<string | null>(null);
  const scope = useRef({ token: session?.access_token, alive: true });
  scope.current.token = session?.access_token;
  const operation = useRef(false);
  const createId = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pageEpoch = useRef(0);
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
      pageEpoch.current++;
    };
  }, []);
  useEffect(() => setTab(route.params?.tab || "browse"), [route.params?.tab]);
  const validFor = (token: string | undefined) =>
    scope.current.alive && scope.current.token === token;

  const loadAccount = useCallback(
    async (reloadStore = false) => {
      const token = session?.access_token;
      const results = await Promise.allSettled([
        api<StoreMine>("/api/store/mine"),
        api<Services>("/api/services/catalog"),
      ]);
      if (!validFor(token)) return;
      if (results[0].status === "fulfilled") {
        setMine(results[0].value);
        const confirmedStore = results[0].value.storefront;
        setStore((current) =>
          reloadStore || current === null ? confirmedStore : current,
        );
      }
      if (results[1].status === "fulfilled") setServices(results[1].value);
      for (const result of results)
        if (result.status === "rejected")
          setError(
            result.reason instanceof Error
              ? result.reason.message
              : "Store could not load. Retry shortly.",
          );
    },
    [api, session?.access_token],
  );
  const loadMarket = useCallback(
    async (after?: number) => {
      if (!session || guest) return;
      const token = session.access_token,
        epoch = ++pageEpoch.current;
      setLoading(true);
      try {
        const result = await api<MarketPage>(
          marketplaceSearch({
            q: query,
            category,
            kind,
            sort,
            minimum,
            maximum,
            after,
            sellerId: route.params?.sellerId,
          }),
        );
        if (!validFor(token) || epoch !== pageEpoch.current) return;
        setItems((previous) =>
          after === undefined
            ? result.items
            : [
                ...previous,
                ...result.items.filter(
                  (item) => !previous.some((row) => row.id === item.id),
                ),
              ],
        );
        setNext(result.next);
        setSellerStore(result.storefront);
      } catch (e) {
        if (validFor(token) && epoch === pageEpoch.current)
          setError(e instanceof Error ? e.message : "Marketplace unavailable.");
      } finally {
        if (validFor(token) && epoch === pageEpoch.current) setLoading(false);
      }
    },
    [
      api,
      session?.access_token,
      guest,
      query,
      category,
      kind,
      sort,
      minimum,
      maximum,
      route.params?.sellerId,
    ],
  );
  useEffect(() => {
    if (session && !guest) void loadAccount();
  }, [loadAccount, guest]);
  useEffect(() => {
    const timer = setTimeout(() => void loadMarket(), 300);
    return () => clearTimeout(timer);
  }, [loadMarket]);

  async function run(label: string, task: () => Promise<void>) {
    if (operation.current || !session || guest) return;
    const token = session.access_token;
    operation.current = true;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (e) {
      if (validFor(token)) {
        setError(
          e instanceof Error ? e.message : "This action could not finish.",
        );
        scrollRef.current?.scrollTo({ y: 0, animated: true });
      }
    } finally {
      operation.current = false;
      if (validFor(token)) setBusy("");
    }
  }
  const switchTab = (value: typeof tab) => {
    setTab(value);
    navigation.setParams({ tab: value });
    setError("");
    setMessage("");
  };
  const newProduct = () => {
    createId.current = null;
    setDraft(emptyListing());
    setPrice("");
    setSellStep("create");
    setPrompt("");
    setPhotoPaths({});
    setMessage("");
  };

  async function saveProduct(status: ListingDraft["status"]) {
    const amount = centsFromText(price || "0");
    if (amount === null)
      throw new Error("Enter a valid USD price with up to two decimal places.");
    const id = draft.id || (createId.current ||= Crypto.randomUUID());
    if (status === "published") {
      if (!mine?.storefront.enabled)
        throw new Error("Enable your storefront before publishing.");
    }
    const value = await api<Listing>("/api/store/listings", {
      ...draft,
      id,
      price_cents: amount,
      status,
    });
    setDraft(editListing(value));
    setMessage(
      status === "published"
        ? "Listing published to Ziipa Store. Payments and fulfillment are not activated yet."
        : "Listing saved to your account.",
    );
    await loadAccount();
    await loadMarket();
  }
  async function uploadPhoto(camera = false) {
    if (!session || draft.photo_ids.length >= 6) return;
    const token = session.access_token;
    let asset: { uri: string; name: string; mimeType?: string; size?: number };
    if (camera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          "Camera access was not granted. You can still add a photo from Files.",
        );
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        exif: false,
        base64: false,
      });
      if (result.canceled || !validFor(token)) return;
      const photo = result.assets[0];
      asset = {
        uri: photo.uri,
        name: photo.fileName || "product-photo.jpg",
        mimeType: photo.mimeType || "image/jpeg",
        size: photo.fileSize,
      };
    } else {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["image/jpeg", "image/png", "image/webp"],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !validFor(token)) return;
      asset = result.assets[0];
    }
    let size = asset.size;
    if (!size) {
      if (Platform.OS === "web")
        size = (await (await fetch(asset.uri)).blob()).size;
      else {
        const info = await FileSystem.getInfoAsync(asset.uri);
        size = info.exists && !info.isDirectory ? info.size : 0;
      }
    }
    if (!size || size > 10 * 1024 * 1024)
      throw new Error("Choose a static product photo up to 10 MB.");
    const photo = await uploadMedia(
      {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType || "image/jpeg",
        size,
      },
      token,
      (percent) => {
        if (validFor(token)) setBusy(`Uploading photo ${percent}%`);
      },
    );
    if (!validFor(token)) return;
    setPhotoPaths((previous) => ({
      ...previous,
      [photo.id]: `/api/creator/media/${photo.id}`,
    }));
    setDraft((previous) => ({
      ...previous,
      photo_ids: [...previous.photo_ids, photo.id],
    }));
    setMessage(
      "Photo uploaded privately. Save the listing to keep it in your storefront.",
    );
  }

  if (!session || guest)
    return (
      <View
        style={{ flex: 1, backgroundColor: color.bg, padding: 22, gap: 16 }}
      >
        <Empty
          title="Your creative marketplace"
          body="Sign into your Ziipa account to browse products, save your storefront and manage services."
        />
        <Action title="Sign in" onPress={() => navigation.navigate("Login")} />
      </View>
    );

  const previewPath =
    draft.photo_ids[0] &&
    (photoPaths[draft.photo_ids[0]] ||
      (draft.id
        ? `/api/store/listings/${draft.id}/photos/${draft.photo_ids[0]}`
        : undefined));
  const columns = desktop ? 3 : 2;
  const group = {
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 20,
    padding: desktop ? 23 : 17,
    gap: 16,
  } as const;
  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: desktop ? 28 : 18,
          paddingBottom: 70,
          gap: 14,
          width: "100%",
          maxWidth: 1220,
          alignSelf: "center",
        }}
      >
        {desktop && (
          <View style={styles.between}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={[styles.heading, { fontSize: desktop ? 34 : 29 }]}>
                Ziipa Store
              </Text>
              <Text style={styles.small}>
                Original work. Independent creators.
              </Text>
            </View>
            <FloatButton
              label="Refresh Store"
              icon={RefreshCw}
              onPress={() => {
                setError("");
                setPhotoEpoch((value) => value + 1);
                void loadAccount(true);
                void loadMarket();
              }}
            />
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View
            accessibilityRole="tablist"
            style={{
              flex: 1,
              flexDirection: "row",
              borderBottomWidth: 1,
              borderBottomColor: color.border,
            }}
          >
            {(
              [
                { id: "browse", title: "Marketplace" },
                { id: "sell", title: "Sell" },
                { id: "services", title: "Services" },
              ] as const
            ).map(({ id, title }) => (
              <Pressable
                key={id}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === id }}
                aria-selected={tab === id}
                onPress={() => switchTab(id)}
                style={{
                  flex: 1,
                  minHeight: 46,
                  alignItems: "center",
                  justifyContent: "center",
                  borderBottomWidth: 2,
                  borderBottomColor: tab === id ? color.purple : "transparent",
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontFamily: tab === id ? font.semibold : font.regular,
                    color: tab === id ? color.text : color.muted,
                  }}
                >
                  {title}
                </Text>
              </Pressable>
            ))}
          </View>
          {!desktop && (
            <FloatButton
              label="Refresh Store"
              icon={RefreshCw}
              onPress={() => {
                setError("");
                setPhotoEpoch((value) => value + 1);
                void loadAccount(true);
                void loadMarket();
              }}
            />
          )}
        </View>
        {!!error && <Notice text={error} error />}
        {!!message && <Notice text={message} />}

        {tab === "browse" && (
          <>
            {sellerStore && (
              <View style={{ gap: 4 }}>
                <Text style={styles.heading}>{sellerStore.name}</Text>
                {!!sellerStore.description && (
                  <Text style={styles.small}>{sellerStore.description}</Text>
                )}
              </View>
            )}
            {!!route.params?.sellerId && (
              <Pill
                title="All Ziipa storefronts"
                onPress={() => navigation.setParams({ sellerId: undefined })}
              />
            )}
            <View
              style={{ flexDirection: "row", alignItems: "flex-end", gap: 9 }}
            >
              <View style={{ flex: 1 }}>
                <Field
                  editable={!busy}
                  label="Search the marketplace"
                  placeholder="Music, films, art, merch…"
                  value={query}
                  onChangeText={setQuery}
                  maxLength={120}
                />
              </View>
              <FloatButton
                label="Product filters"
                icon={SlidersHorizontal}
                active={filters}
                onPress={() => setFilters(!filters)}
              />
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              <Pill
                title="All"
                active={category === "all"}
                onPress={() => setCategory("all")}
              />
              {productCategories.map((value) => (
                <Pill
                  key={value.id}
                  title={value.title}
                  active={category === value.id}
                  onPress={() => setCategory(value.id)}
                />
              ))}
            </ScrollView>
            {filters && (
              <View style={group}>
                <Text style={styles.label}>Product type</Text>
                <View
                  style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}
                >
                  {[
                    ["all", "All"],
                    ["digital", "Digital media"],
                    ["merchandise", "Merchandise"],
                  ].map(([id, title]) => (
                    <Pill
                      key={id}
                      title={title}
                      active={kind === id}
                      onPress={() => setKind(id)}
                    />
                  ))}
                </View>
                <Text style={styles.label}>Sort by</Text>
                <View
                  style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}
                >
                  {[
                    ["newest", "Newest"],
                    ["price_low", "Price ↑"],
                    ["price_high", "Price ↓"],
                  ].map(([id, title]) => (
                    <Pill
                      key={id}
                      title={title}
                      active={sort === id}
                      onPress={() => setSort(id)}
                    />
                  ))}
                </View>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      editable={!busy}
                      label="Min USD"
                      value={minimum}
                      onChangeText={setMinimum}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      editable={!busy}
                      label="Max USD"
                      value={maximum}
                      onChangeText={setMaximum}
                      keyboardType="decimal-pad"
                    />
                  </View>
                </View>
                <Action
                  title="Reset filters"
                  secondary
                  onPress={() => {
                    setCategory("all");
                    setKind("all");
                    setSort("newest");
                    setMinimum("");
                    setMaximum("");
                    setQuery("");
                    navigation.setParams({ sellerId: undefined });
                  }}
                />
              </View>
            )}
            <View style={styles.between}>
              <Text style={[styles.heading, { fontSize: 22 }]}>
                {route.params?.sellerId
                  ? "Creator storefront"
                  : "From the Ziipa community"}
              </Text>
              {loading && <ActivityIndicator color={color.lime} />}
            </View>
            {!loading && !items.length && (
              <Empty
                title="A space for original products"
                body="No published products match this view yet. Create a listing in Sell, or try different filters."
              />
            )}
            <View
              testID="marketplace-product-grid"
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                rowGap: 12,
                marginHorizontal: desktop ? -2 : -18,
              }}
            >
              {items.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}, ${money(item.price_cents)}, ${item.store_name}`}
                  onPress={() => {
                    setSelectedPhoto(0);
                    setSelected(item);
                  }}
                  style={{
                    width: `${100 / columns}%`,
                    gap: 5,
                    paddingHorizontal: 2,
                    paddingBottom: 8,
                  }}
                >
                  <ProductDisplay
                    key={`${item.id}:${photoEpoch}`}
                    tile
                    item={item}
                    path={item.photos[0]}
                  />
                  <Text
                    style={{
                      color: color.text,
                      fontFamily: font.bold,
                      fontSize: 16,
                    }}
                  >
                    {money(item.price_cents)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.body, { fontSize: 14, lineHeight: 19 }]}
                  >
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.small}>
                    {item.store_name}
                  </Text>
                </Pressable>
              ))}
            </View>
            {next !== null && (
              <Action
                title="More products"
                busy={loading}
                secondary
                onPress={() => void loadMarket(next)}
              />
            )}
          </>
        )}

        {tab === "sell" && (
          <View style={{ gap: 12 }}>
            <StoreSellWizard
              onNew={() => {
                if (!operation.current) {
                  newProduct();
                  setOpenSellPanel(null);
                }
              }}
              step={sellStep}
              onStep={(step) => {
                if (!operation.current) {
                  setSellStep(step);
                  scrollRef.current?.scrollTo({ y: 0, animated: true });
                }
              }}
              draft={draft}
              onChange={(patch) => {
                if (!operation.current)
                  setDraft((previous) => ({ ...previous, ...patch }));
              }}
              price={price}
              onPrice={setPrice}
              prompt={prompt}
              onPrompt={setPrompt}
              consent={consent}
              onConsent={() => setConsent(!consent)}
              busy={busy}
              preview={
                <ProductDisplay
                  item={{
                    ...draft,
                    price_cents: centsFromText(price) || 0,
                    overlay:
                      sellStep === "create" || centsFromText(price) === null
                        ? "none"
                        : draft.overlay,
                  }}
                  path={previewPath}
                />
              }
              onUpload={() => void run("Uploading photo", uploadPhoto)}
              onCamera={
                Platform.OS === "web"
                  ? undefined
                  : () => void run("Uploading photo", () => uploadPhoto(true))
              }
              onGenerate={() =>
                void run("Preparing suggestions", async () => {
                  const value = await api<{ suggestion: Suggestion }>(
                    "/api/store/suggest",
                    { prompt, kind: draft.kind, consent: true },
                  );
                  setDraft((previous) =>
                    applyListingSuggestion(previous, value.suggestion),
                  );
                  if (store && store.revision === 0)
                    setStore({
                      ...store,
                      name: value.suggestion.storefront_name,
                    });
                  setSellStep("review");
                  setMessage(
                    "AI draft ready. Review the copy, set your price and check the display.",
                  );
                  scrollRef.current?.scrollTo({ y: 0, animated: true });
                })
              }
              onSave={(status) =>
                void run(
                  status === "published"
                    ? "Publishing product"
                    : status === "draft"
                      ? "Saving product"
                      : "Updating listing",
                  () => saveProduct(status),
                )
              }
              storeName={store?.name || "My store"}
              storeEnabled={!!mine?.storefront.enabled}
              onEnableStore={() => {
                if (!store) return;
                void run("Saving storefront", async () => {
                  const saved = await api<Storefront>("/api/store/storefront", {
                    ...store,
                    enabled: !mine?.storefront.enabled,
                  });
                  setStore(saved);
                  setMine((value) =>
                    value ? { ...value, storefront: saved } : value,
                  );
                });
              }}
              onStore={() => setOpenSellPanel("store")}
              onProducts={() => setOpenSellPanel("products")}
            />
          </View>
        )}

        {tab === "services" && (
          <>
            <View style={{ gap: 5 }}>
              <Text style={[styles.heading, { fontSize: 23 }]}>Services</Text>
              <Text style={styles.small}>
                One account across iPhone, Android and web. Prices below are
                proposals.
              </Text>
            </View>
            <View style={{ gap: 10 }}>
              <Disclosure
                title="Account & usage"
                detail={
                  services
                    ? `${(services.storage.used_bytes / 1024 ** 3).toFixed(2)} of ${(services.storage.limit_bytes / 1024 ** 3).toFixed(0)} GiB used`
                    : "Loading allowances…"
                }
                icon={Package}
                expanded={openServicePanel === "usage"}
                onToggle={() =>
                  setOpenServicePanel(
                    openServicePanel === "usage" ? null : "usage",
                  )
                }
              >
                <Text style={styles.body}>
                  Your current account allowance applies on every device. Paid
                  access is verified by the server.
                </Text>
                <Notice
                  text={
                    services?.purchase_requirements ||
                    "Loading your account allowances…"
                  }
                />
              </Disclosure>
              {[
                {
                  id: "plans",
                  title: "Creator plans",
                  detail: "Free · Creator · Studio",
                  storageOnly: false,
                },
                {
                  id: "storage",
                  title: "Storage add-ons",
                  detail: "10 / 50 GiB proposals",
                  storageOnly: true,
                },
              ].map(({ id, title, detail, storageOnly }) => (
                <Disclosure
                  key={id}
                  title={title}
                  detail={detail}
                  icon={storageOnly ? Package : Sparkles}
                  expanded={openServicePanel === id}
                  onToggle={() =>
                    setOpenServicePanel(openServicePanel === id ? null : id)
                  }
                >
                  {services?.catalog.plans
                    .filter(
                      (plan) => storageOnly === plan.id.startsWith("storage_"),
                    )
                    .map((plan) => (
                      <View
                        key={plan.id}
                        style={{
                          borderBottomWidth: 1,
                          borderBottomColor: color.border,
                          paddingVertical: 14,
                          gap: 8,
                        }}
                      >
                        <View style={styles.between}>
                          <Text style={[styles.heading, { fontSize: 18 }]}>
                            {plan.name}
                          </Text>
                          <Text
                            style={{
                              color: color.lime,
                              fontFamily: font.bold,
                              fontSize: 17,
                            }}
                          >
                            {plan.monthly_price_cents
                              ? `${money(plan.monthly_price_cents)}/mo`
                              : "Free"}
                          </Text>
                        </View>
                        <Text style={styles.body}>{plan.summary}</Text>
                        <Text style={styles.small}>
                          {plan.storage_gib} GiB storage ·{" "}
                          {plan.id === "free"
                            ? "Current free allowance"
                            : "Draft proposal · not yet on sale"}
                        </Text>
                        {services.grants.some(
                          (grant) => grant.plan === plan.id,
                        ) && (
                          <Text style={{ color: color.lime }}>
                            Verified on your account
                          </Text>
                        )}
                        {options
                          .filter((option) => option.plan === plan.id)
                          .map((option) => (
                            <Action
                              key={option.id}
                              title={`Review ${option.price} purchase`}
                              disabled={!!busy}
                              onPress={() =>
                                void run("Opening checkout", async () => {
                                  await option.purchase();
                                  setServices(
                                    await api<Services>(
                                      "/api/services/refresh",
                                      {},
                                    ),
                                  );
                                  setMessage(
                                    "Purchase checked with the server. Your verified account access is shown above.",
                                  );
                                })
                              }
                            />
                          ))}
                      </View>
                    ))}
                </Disclosure>
              ))}
              <Disclosure
                title="Feature limits"
                detail={`${services?.catalog.features.length || 0} feature groups · free and proposed upgrades`}
                icon={SlidersHorizontal}
                expanded={openServicePanel === "features"}
                onToggle={() =>
                  setOpenServicePanel(
                    openServicePanel === "features" ? null : "features",
                  )
                }
              >
                {services?.catalog.features.map((feature) => (
                  <Disclosure
                    key={feature.id}
                    title={feature.name}
                    detail={feature.status.replaceAll("_", " ")}
                    expanded={openFeature === feature.id}
                    onToggle={() =>
                      setOpenFeature(
                        openFeature === feature.id ? null : feature.id,
                      )
                    }
                  >
                    <Text style={styles.body}>Free: {feature.free}</Text>
                    <Text style={styles.body}>Proposed: {feature.upgrade}</Text>
                    <Text style={styles.small}>{feature.activation}</Text>
                  </Disclosure>
                ))}
              </Disclosure>
              <Disclosure
                title="Purchases & restore"
                detail={
                  services?.billing_enabled && !iosLimitedTestflight
                    ? "Review store prices or restore access"
                    : "Purchases not activated"
                }
                icon={ShoppingBag}
                expanded={openServicePanel === "purchases"}
                onToggle={() =>
                  setOpenServicePanel(
                    openServicePanel === "purchases" ? null : "purchases",
                  )
                }
              >
                {services?.billing_enabled && !iosLimitedTestflight && (
                  <View style={group}>
                    <Action
                      title="Load available store prices"
                      icon={ShoppingBag}
                      disabled={!!busy}
                      onPress={() =>
                        void run("Loading purchases", async () => {
                          const context = await api<PurchaseContext>(
                            "/api/services/purchase-context",
                            {
                              platform: Platform.OS,
                            },
                          );
                          setPurchaseContext(context);
                          setOptions(await serviceOptions(context));
                        })
                      }
                    />
                    <Action
                      title="Restore purchases"
                      secondary
                      disabled={!!busy}
                      onPress={() =>
                        void run("Restoring purchases", async () => {
                          const context =
                            purchaseContext ||
                            (await api<PurchaseContext>(
                              "/api/services/purchase-context",
                              {
                                platform: Platform.OS,
                              },
                            ));
                          await restoreServices(context);
                          setServices(
                            await api<Services>("/api/services/refresh", {}),
                          );
                          setMessage(
                            "Purchase status refreshed for your Ziipa account.",
                          );
                        })
                      }
                    />
                    {Platform.OS !== "web" && (
                      <Action
                        title="Manage platform subscriptions"
                        secondary
                        onPress={() =>
                          void Linking.openURL(
                            Platform.OS === "ios"
                              ? "https://apps.apple.com/account/subscriptions"
                              : "https://play.google.com/store/account/subscriptions",
                          )
                        }
                      />
                    )}
                  </View>
                )}

                {(!services?.billing_enabled || iosLimitedTestflight) && (
                  <Notice text="Purchases are not activated in this build. You can review the proposed packages without being charged." />
                )}
              </Disclosure>
            </View>
          </>
        )}
      </ScrollView>
      {openSellPanel && tab === "sell" && (
        <Sheet
          title={
            openSellPanel === "store" ? "Storefront settings" : "Your products"
          }
          onClose={() => setOpenSellPanel(null)}
        >
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {openSellPanel === "store" ? (
              <View style={{ gap: 12 }}>
                {" "}
                <View
                  style={{
                    flexDirection: "row",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <Store color={color.lime} size={24} />
                  <Text style={[styles.heading, { fontSize: 23 }]}>
                    Your mini storefront
                  </Text>
                </View>
                {store ? (
                  <>
                    <Field
                      editable={!busy}
                      label="Store name"
                      value={store.name}
                      maxLength={70}
                      onChangeText={(name) => setStore({ ...store, name })}
                    />
                    <Field
                      editable={!busy}
                      label="About your store"
                      value={store.description}
                      maxLength={500}
                      multiline
                      onChangeText={(description) =>
                        setStore({ ...store, description })
                      }
                    />
                    <Toggle
                      disabled={!!busy}
                      value={store.enabled}
                      title="Show my published products in Ziipa Store"
                      onChange={() =>
                        setStore({ ...store, enabled: !store.enabled })
                      }
                    />
                    <Action
                      title="Save storefront"
                      icon={Check}
                      busy={busy === "Saving storefront"}
                      disabled={!!busy}
                      secondary
                      onPress={() =>
                        void run("Saving storefront", async () => {
                          const saved = await api<Storefront>(
                            "/api/store/storefront",
                            store,
                          );
                          setStore(saved);
                          await loadAccount();
                          setMessage("Storefront saved to your account.");
                        })
                      }
                    />
                  </>
                ) : (
                  <Action
                    title="Load storefront"
                    secondary
                    onPress={() => void loadAccount()}
                  />
                )}
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                {" "}
                <Text style={[styles.heading, { fontSize: 23 }]}>
                  Your products
                </Text>
                {!mine?.listings.length && (
                  <Text style={styles.small}>
                    Your saved drafts and published products will appear here on
                    every device.
                  </Text>
                )}
                {mine?.listings.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    disabled={!!busy || item.status === "hidden"}
                    onPress={() => {
                      setDraft(editListing(item));
                      setPrice((item.price_cents / 100).toFixed(2));
                      setPhotoPaths({});
                      setOpenSellPanel(null);
                      setSellStep("review");
                      scrollRef.current?.scrollTo({ y: 0, animated: true });
                      setMessage(`Editing ${item.title}.`);
                    }}
                    style={[group, { gap: 5, padding: 16 }]}
                  >
                    <Text style={[styles.body, { fontFamily: font.bold }]}>
                      {item.title}
                    </Text>
                    <Text style={styles.small}>
                      {money(item.price_cents)} · {item.status} · revision{" "}
                      {item.revision}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </Sheet>
      )}
      {selected && (
        <Sheet title={selected.title} onClose={() => setSelected(null)}>
          <ProductDisplay
            large
            item={selected}
            path={selected.photos[selectedPhoto]}
          />
          {selected.photos.length > 1 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {selected.photos.map((path, index) => (
                <Pill
                  key={path}
                  title={`Photo ${index + 1}`}
                  active={selectedPhoto === index}
                  onPress={() => setSelectedPhoto(index)}
                />
              ))}
            </View>
          )}
          <Text style={[styles.heading, { fontSize: 27 }]}>
            {money(selected.price_cents)}
          </Text>
          <Text style={styles.body}>{selected.description}</Text>
          <Text style={styles.small}>
            {selected.kind === "digital"
              ? "Digital media"
              : `Merchandise · ${selected.condition.replaceAll("_", " ")}`}
          </Text>
          <Text style={styles.body}>{selected.delivery}</Text>
          <Action
            title={`View ${selected.store_name}`}
            secondary
            onPress={() => {
              navigation.setParams({
                sellerId: selected.seller_id,
                tab: "browse",
              });
              setSelected(null);
              setTab("browse");
            }}
          />
          <Notice text="Purchasing is not activated yet. No payment is taken and no paid file is delivered from this listing." />
          <Action
            title="Report this listing"
            secondary
            disabled={!!busy}
            onPress={() =>
              void run("Reporting listing", async () => {
                await api(`/api/store/listings/${selected.id}/report`, {
                  reason:
                    "Please review this listing for rights, accuracy or marketplace safety.",
                });
                setSelected(null);
                setMessage("Report saved for moderation.");
              })
            }
          />
        </Sheet>
      )}
    </View>
  );
}
