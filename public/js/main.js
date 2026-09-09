/**
 * SOCIALSFORCE
 * Main JavaScript
 */


/* =========================================
   ELEMENTS
========================================= */

const searchButton = document.getElementById("search-button");
const searchContainer = document.getElementById("search-container");
const searchInput = document.getElementById("search-input");

const categoriesButton = document.getElementById("categories-button");
const categoriesMenu = document.getElementById("categories-menu");

const mobileMenuButton = document.getElementById("mobile-menu-button");
const mobileNavigation = document.getElementById("mobile-navigation");


/* =========================================
   SEARCH
========================================= */

/**
 * Open and close the search bar.
 */
if (searchButton) {

    searchButton.addEventListener("click", () => {

        searchContainer.classList.toggle("active");

        if (searchContainer.classList.contains("active")) {

            searchInput.focus();

        }

    });

}


/* =========================================
   CATEGORIES
========================================= */

/**
 * Open and close the categories menu.
 *
 * This uses click instead of hover so the user
 * can move the mouse into the menu and click
 * a category without it disappearing.
 */

if (categoriesButton) {

    categoriesButton.addEventListener("click", (event) => {

        event.stopPropagation();

        categoriesMenu.classList.toggle("active");

        const isOpen =
            categoriesMenu.classList.contains("active");

        categoriesButton.setAttribute(
            "aria-expanded",
            isOpen
        );

    });

}


/**
 * Prevent clicks inside the categories menu
 * from closing it.
 */

if (categoriesMenu) {

    categoriesMenu.addEventListener("click", (event) => {

        event.stopPropagation();

    });

}


/**
 * Close categories when clicking somewhere else.
 */

document.addEventListener("click", () => {

    if (categoriesMenu) {

        categoriesMenu.classList.remove("active");

    }

    if (categoriesButton) {

        categoriesButton.setAttribute(
            "aria-expanded",
            "false"
        );

    }

});


/* =========================================
   MOBILE MENU
========================================= */

/**
 * Open and close the mobile navigation.
 */

if (mobileMenuButton) {

    mobileMenuButton.addEventListener("click", (event) => {

        event.stopPropagation();

        mobileNavigation.classList.toggle("active");

    });

}