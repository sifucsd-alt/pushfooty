const FEEDS = [
  // EPL
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml", source: "BBC Sport", league: "EPL" },
  { url: "https://www.skysports.com/rss/12040", source: "Sky Sports", league: "EPL" },
  { url: "https://www.theguardian.com/football/premierleague/rss", source: "The Guardian", league: "EPL" },

  // Champions League
  { url: "https://www.theguardian.com/football/championsleague/rss", source: "The Guardian", league: "UCL" },
  { url: "https://feeds.bbci.co.uk/sport/football/european/rss.xml", source: "BBC Sport", league: "UCL" },

  // PSL (South Africa)
  { url: "https://www.kickoff.com/rss/news", source: "Kickoff", league: "PSL" },
  { url: "https://www.soccerladuma.co.za/rss", source: "Soccer Laduma", league: "PSL" },
  { url: "https://supersport.com/rss/football", source: "SuperSport", league: "PSL" },

  // UAE / Qatar
  { url: "https://www.goal.com/feeds/en/news", source: "Goal", league: "GULF" },
  { url: "https://www.skysports.com/rss/12040", source: "Sky Sports Arabia", league: "GULF" },
];

module.exports = FEEDS;
