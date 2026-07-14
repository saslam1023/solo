const state = {

products:[],

cart:[]

};


const CDN = "https://cdn.headorn.com";

const API = "/storefront";



function money(value){

return new Intl.NumberFormat(
"en-GB",
{
style:"currency",
currency:"GBP"
}
).format(value / 100);

}



function setSEO(store){


const title =
`${store.name} | Headorn Store`;


const description =
store.description ||
`Shop products from ${store.name}`;



document.title = title;


document
.getElementById("seo-title")
.content = title;


document
.getElementById("seo-description")
.content = description;



document
.getElementById("og-title")
.content = title;


document
.getElementById("og-description")
.content = description;


document
.getElementById("twitter-title")
.content = title;


document
.getElementById("twitter-description")
.content = description;



document
.getElementById("seo-canonical")
.href =
window.location.href;



}



function setStructuredData(store){


const schema={

"@context":"https://schema.org",

"@type":"Store",

"name":store.name,

"description":
store.description || "",

"url":
window.location.origin

};


document
.getElementById("store-schema")
.textContent =
JSON.stringify(schema);


}



async function loadStore(){


const response =
await fetch(
`${API}/products`,
{
credentials:"include"
}
);


const data =
await response.json();



state.products =
data.products || [];



const store =
data.store || {};



document
.getElementById("store-name")
.textContent =
store.name || "Store";


document
.getElementById("store-title")
.textContent =
store.name || "Store";


document
.getElementById("store-description")
.textContent =
store.description || "";



setSEO(store);

setStructuredData(store);



renderProducts();


}



function renderProducts(){


const grid =
document.getElementById(
"product-grid"
);



grid.innerHTML =
state.products
.map(product=>{


const image =
product.imageUrl ||
`${CDN}/placeholder-product.jpg`;



return `

<article class="product-card">


<img

class="product-image"

src="${image}"

alt="${product.name}"

loading="lazy"

/>


<h2 class="product-title">

${product.name}

</h2>


<p>

${product.description || ""}

</p>


<p class="product-price">

${money(product.price)}

</p>


<button
onclick="addToCart('${product.id}')"
>

Add to cart

</button>


</article>

`;

})
.join("");

}



window.addToCart=function(id){


const product =
state.products.find(
p=>p.id===id
);



if(!product)return;



state.cart.push(product);


renderCart();


};



function renderCart(){


document
.getElementById("cart-count")
.textContent =
state.cart.length;



document
.getElementById("cart-items")
.innerHTML =
state.cart
.map(item=>`

<div class="cart-item">

${item.name}

<strong>

${money(item.price)}

</strong>

</div>

`)
.join("");



const total =
state.cart.reduce(
(sum,item)=>sum+item.price,
0
);



document
.getElementById("cart-total")
.textContent =
money(total);



}



document
.getElementById("cart-open")
.onclick=()=>{

document
.getElementById("cart-panel")
.hidden=false;

};



document
.getElementById("cart-close")
.onclick=()=>{

document
.getElementById("cart-panel")
.hidden=true;

};



document
.getElementById("checkout")
.onclick=async()=>{


const response =
await fetch(
`${API}/checkout`,
{

method:"POST",

headers:{
"content-type":"application/json"
},

credentials:"include",

body:JSON.stringify({

items:
state.cart.map(item=>({

productId:item.id,

quantity:1

}))

})

}
);



const data =
await response.json();



if(data.url){

window.location.href=data.url;

}


};



loadStore()
.catch(console.error);