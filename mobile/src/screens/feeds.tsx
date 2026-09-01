import { useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SlidersHorizontal } from "lucide-react-native";
import {
  Action,
  categories,
  Empty,
  Field,
  ItemRow,
  Logo,
  Notice,
  Pill,
} from "../components/ui";
import { color, styles } from "../theme";
import { useZiipa } from "../provider";
import { matchesFeed } from "../lib/domain";
import type { Feed, FeedInput, RootStack } from "../lib/types";

const blank: FeedInput = {
  name: "",
  category: "all",
  tag: "",
  city: "",
  creator: "",
  shared: false,
};
export function FeedsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { data, guest, api, refresh, savePreviewFeed } = useZiipa();
  const [rule, setRule] = useState<FeedInput>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const matches = data.items.filter((i) => matchesFeed(i, rule));
  function patch(value: Partial<FeedInput>) {
    setRule((r) => ({ ...r, ...value }));
    setMessage("");
  }
  async function save() {
    if (!rule.name.trim()) {
      setError("Give your feed a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (guest) {
        savePreviewFeed({ ...rule, name: rule.name.trim(), shared: false });
        setMessage(
          "Sample feed saved for this session. It is not published or shared.",
        );
        return;
      }
      await api("/api/creator/feeds", {
        ...rule,
        name: rule.name.trim(),
        tag: rule.tag.trim().replace(/^#/, ""),
      });
      await refresh();
      setMessage("Your feed rules are saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function load(feed: Feed) {
    setRule({
      name: feed.name,
      category: feed.category,
      tag: feed.tag,
      city: feed.city,
      creator: feed.creator,
      shared: false,
    });
    setMessage(`Previewing “${feed.name}”. Save to keep a new copy.`);
  }
  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
      >
        <Logo />
        <View style={{ gap: 12 }}>
          <Text style={styles.eyebrow}>A FEED THAT FEELS LIKE YOU</Text>
          <Text style={styles.title}>Your feed.{"\n"}Your rules.</Text>
          <Text style={styles.body}>
            More of what moves you. Choose a few rules and see your corner of
            Ziipa take shape.
          </Text>
        </View>
        <View style={styles.panel}>
          <Field
            label="Feed name"
            value={rule.name}
            onChangeText={(name) => patch({ name })}
            maxLength={80}
            placeholder="Good energy only"
            editable={!busy}
          />
          <ScrollView
            showsVerticalScrollIndicator={false}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            <Pill
              title="Everything"
              active={rule.category === "all"}
              onPress={() => patch({ category: "all" })}
            />
            {categories.map((c) => (
              <Pill
                key={c.id}
                title={c.title}
                active={rule.category === c.id}
                onPress={() => patch({ category: c.id })}
              />
            ))}
          </ScrollView>
          <Field
            label="Tag (optional)"
            value={rule.tag}
            onChangeText={(tag) => patch({ tag })}
            maxLength={40}
            placeholder="music"
            autoCapitalize="none"
            editable={!busy}
          />
          <Field
            label="Creator (optional)"
            value={rule.creator}
            onChangeText={(creator) => patch({ creator })}
            maxLength={100}
            editable={!busy}
          />
          <Field
            label="Declared city (optional)"
            value={rule.city}
            onChangeText={(city) => patch({ city })}
            maxLength={80}
            editable={!busy}
          />
          <View style={styles.between}>
            <Text style={[styles.small, { flex: 1 }]}>
              Share these rules with other Ziipa members
            </Text>
            <Switch
              accessibilityLabel="Share feed rules"
              value={rule.shared}
              onValueChange={(shared) => patch({ shared })}
              trackColor={{ true: color.purple }}
              disabled={busy || guest}
            />
          </View>
          <Action
            title={guest ? "Save sample feed" : "Save feed rules"}
            icon={SlidersHorizontal}
            onPress={() => void save()}
            busy={busy}
          />
        </View>
        {!!error && <Notice error text={error} />}
        {!!message && <Notice text={message} />}
        <Text style={styles.heading}>Your results · {matches.length}</Text>
        <Text style={styles.small}>
          All selected rules must match. Your safety preferences still apply.
          Cities are provided by creators; location services are not used.
        </Text>
        {matches.length ? (
          matches
            .slice(0, 12)
            .map((item) => (
              <ItemRow
                item={item}
                key={item.id}
                onPress={() => navigation.navigate("Post", { item })}
              />
            ))
        ) : (
          <Empty
            title="Try a little wider."
            body="Remove a filter or try a different tag."
          />
        )}
        {data.feeds.length > 0 && (
          <>
            <Text style={styles.heading}>Your saved feeds</Text>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {data.feeds.map((feed) => (
                <Pill
                  key={feed.id}
                  title={feed.name}
                  onPress={() => load(feed)}
                />
              ))}
            </View>
          </>
        )}
        {data.community_feeds.length > 0 && (
          <>
            <Text style={styles.heading}>From the community</Text>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {data.community_feeds.map((feed) => (
                <Pill
                  key={feed.id}
                  title={`${feed.name} · ${feed.owner_name}`}
                  onPress={() => load(feed)}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
