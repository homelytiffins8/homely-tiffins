export const metadata = {
  title: "Homely Tiffins",
  description: "Fresh, home-style meals — delivered within the society",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
