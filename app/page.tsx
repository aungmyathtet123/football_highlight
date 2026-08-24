import type { Metadata } from "next";
import { VideoStudio } from "./video-studio";

export const metadata: Metadata = {
  title: "New football edit",
  description: "Turn full football matches into concise vertical analysis videos.",
};

export default function Home() {
  return <VideoStudio />;
}
