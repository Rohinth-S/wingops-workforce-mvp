import "dotenv/config"; import app from "./app.js"; const port=Number(process.env.PORT??4040); app.listen(port,()=>console.log(`WingOps API listening on :${port}`));
