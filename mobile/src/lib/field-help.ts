export const sectionHelp: Readonly<Record<string, string>> = {
  "Created in Ziipa":
    "Your own Ziipa creations, including private drafts and published work. Original files without a creation are grouped under Original uploads.",
  "By Network Syncs":
    "Posts already imported through your connected networks, grouped by provider. Open a card to view its original post. Opening this library does not start a new sync.",
  "Original uploads":
    "Stored source files that are not yet attached to a creation. Open one to create a private draft.",
  "Assistant permissions":
    "Choose which tools the Assistant may use. Review proposed chat changes before approving them. Agent tasks also follow their separately saved policy.",
  "Conversation controls":
    "Manage the Assistant conversation. Clearing chat history is separate from deleting saved media or memories.",
  "Run history":
    "Queued and processing entries are still in progress. Review the result or error before assuming a workflow completed.",
  "Creator economics":
    "A ledger of figures you enter. Expected income is separate from received income, and different currencies are not added together.",
  "Insights grounded in your activity":
    "These counts reflect Ziipa activity. They do not estimate external views, audience totals or payouts.",
};

/** Context help for unambiguous field labels shared by mobile and web. */
export const fieldHelp: Readonly<Record<string, string>> = {
  "What should Ziipa complete?":
    "Describe a concrete private workspace objective. For example, find launch clips and organize them into a project. Review the task before confirming it.",
  "Maximum steps per task (1–10)":
    "Limits how many approved private actions one task may complete. A smaller limit keeps each task bounded.",
  "Maximum tasks per UTC day (1–20)":
    "Limits how many tasks may run each day, counted using UTC rather than your local timezone.",
  "Starts · date/time with timezone":
    "Include a timezone offset or Z for UTC so the start time identifies one exact instant.",
  "Ends · date/time with timezone":
    "Use a time after the start, including its timezone offset or Z for UTC.",
  "Delivery date and time · include timezone":
    "The planned time to send the approved campaign. Include a timezone offset or Z for UTC; review each destination before approval.",
  "Timed transcript notes · seconds: start --> end | text":
    "Enter one caption per line with start and end times in seconds, followed by its words. Review timestamps against your video before approval.",
  "Transcript corrections / manual transcript":
    "Edit the recognized words or enter your own transcript. Review caption timing separately before publishing.",
  "Creation title":
    "Give your creation a descriptive name. A title is required before saving or publishing; you can edit suggested text.",
  "Creation title (required)":
    "Give your creation a descriptive name. A title is required before saving or publishing; you can edit suggested text.",
  "Tags · separated by commas":
    "Add words that describe your creation, separated by commas, such as travel, music, behind the scenes.",
  "Tags, separated by commas":
    "Separate each tag with a comma. Tags help organize and find this media.",
  "City (optional)":
    "Add a city to describe your creation. Leave this blank if you do not want to include a location.",
  "Declared city (optional)":
    "This uses the city entered on a creation, rather than your device's current location.",
  "Private notes":
    "Notes are for your own media organization and are not part of the public creation description.",
  "Timezone · IANA name":
    "Use a region name such as America/New_York or Europe/London. Ziipa uses this timezone to interpret the event's local date and time.",
  "Local time · 24-hour HH:mm":
    "Enter a 24-hour time, such as 09:30 or 18:00, in the event's selected timezone.",
  "Advanced local date and time · no offset":
    "Enter the local date and time in the selected timezone. Do not add Z or a UTC offset here.",
  "Planned duration · minutes":
    "The planned length of your event. This does not automatically start or end a broadcast.",
  "Reminder lead time · minutes before":
    "How long before the event Ziipa should prepare a reminder. Device notifications require their own permission and settings.",
  "Maximum occurrences · 1–52":
    "The maximum number of dates to create for this repeating event, including the first date.",
  "Optional last local date · YYYY-MM-DD":
    "Stop repeating after this date in the event's timezone. Leave blank to use the occurrence limit.",
  "Profile URL or handle":
    "Use the profile or channel you want to connect, rather than a link to an individual post. Linking a profile does not automatically import or publish posts.",
  "Bluesky handle":
    "Use your full handle, such as name.bsky.social. Review the account before authorizing a connection.",
  "Original source URL (optional)":
    "Keep an HTTPS link to the original source so you can review where the media came from.",
  "License or permission notes":
    "Record the permission or licence that lets you reuse this media. Saving a note does not grant new rights.",
  "Rights expiry (optional)":
    "Record when the permission ends. Review the source's terms before reusing the media.",
  "Due date and time (optional)":
    "Include a timezone offset or Z for UTC so the saved deadline refers to one exact instant.",
  "First run date and time":
    "Include a timezone offset or Z for UTC. Review the workflow's action before enabling it.",
  "Repeat every N minutes (optional)":
    "Leave blank for a single run. A repeating workflow uses this interval between runs.",
  "Steps (one per line)":
    "Enter each goal step on a new line so you can track its completion separately.",
  "Amount in minor units":
    "Enter a whole number in the currency's smallest unit. For USD, 1250 means $12.50. This records a ledger entry; it does not transfer money.",
  "Currency code":
    "Use a three-letter currency code, such as USD, GBP or EUR. Ziipa keeps different currencies separate.",
  "Occurred at (optional; defaults to now)":
    "The date and time of this ledger entry. Include a timezone offset or Z for UTC; leave blank to use the current time.",
  "Number of excerpts (1–3)":
    "Choose how many sequential clips to prepare from the recording. Clips remain private until you publish them.",
  "Seconds per excerpt (15–90)":
    "The length of each sequential clip. These are not automatically selected highlights.",
  "Overlay start":
    "The point in the edited video when this overlay begins, measured in seconds.",
  "Overlay end":
    "The point in the edited video when this overlay stops, measured in seconds.",
  "Muted words and phrases":
    "Hide matching content from your feeds. Separate entries as shown in the field; this does not delete anyone's posts.",
  "Device name (optional)":
    "Choose a label that helps you recognize this device in your notification settings.",
  "Suggested resale royalty (%)":
    "A suggested percentage for later resales. Marketplace support determines whether a royalty is paid.",
  "Token symbol":
    "A short identifier for this token. Review it carefully before approving a wallet transaction.",
  "Fixed supply · 18 decimals":
    "The total token supply uses 18 decimal places. Review the amount before creating the token.",
  "Recipient wallet address":
    "The blockchain address that will receive the asset. Check the full address and network before approving a transaction.",
  "Optional curator split (%)":
    "An optional share assigned to the curator address. Review the recipients and split in the wallet before approval.",
  "Curator wallet address":
    "The blockchain address receiving the optional curator share. Check the complete address and selected network.",
  "Collection / trait":
    "Optional metadata describing the collection or a characteristic of this creation.",
  "IPFS media URI":
    "An ipfs:// address identifies content stored on IPFS. Review the media and its availability before creating a token.",
  "Or use an IPFS media URI":
    "Use an existing ipfs:// media address instead of selecting an uploaded source.",
};
